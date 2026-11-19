/**
 * Verifier: run task assertions read-only through one narrow seam (17 §8.5).
 *
 * - Only `file_exists` / `port_listening` / `http_status` have built-in probes.
 * - `service_active` / `page_contains` must be injected by the owning adapter;
 *   without one the assertion is `skipped`, never silently "passed".
 * - `exit_code` reads the recorded execution evidence; it is never re-run
 *   (re-running a side-effecting command would defeat "verify is read-only").
 * - `skipped` means "could not decide": completion refuses it.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { redactDeep } from '@dsh-wfxm/redact'
import { TaskError, requiresCriteria, type AssertionKind, type JsonObject, type Task, type TaskAssertion } from './model.js'
import type { TaskStore } from './store.js'

const execFileAsync = promisify(execFile)

export type OutcomeStatus = 'pass' | 'fail' | 'skipped'

export interface AssertionOutcome {
  status: OutcomeStatus
  evidence: JsonObject
}

export interface VerifyContext {
  /** Repository / workspace root used by `git_diff_matches`. */
  cwd?: string
  /** Per-assertion budget; defaults to 60s (17 §8.5 rule 3). */
  timeoutMs?: number
  /** Exit code recorded when the task's command ran; absent = not verifiable. */
  execExitCode?: number | null
  /** Adapter hook for `service_active` (SvcOps). */
  serviceStatus?: (unit: string) => Promise<'active' | 'inactive' | 'unknown'>
  /**
   * Adapter hook for `unit_restarted` (SvcOps): current state plus when the unit
   * last entered `active`. `activeEnteredAtMs` must be epoch milliseconds.
   */
  unitState?: (unit: string) => Promise<{
    activeState: 'active' | 'inactive' | 'unknown'
    activeEnteredAtMs: number | null
  }>
  /** Filled by `verifyTask` from `task.startedAt`; baseline for `unit_restarted`. */
  taskStartedAt?: string | null
  /**
   * Adapter hook for `mail_archived` (Mail): read-only SELECT of the archive
   * folder and its EXISTS count. `folder` null means the adapter's default
   * (`DSH_WFXM_MAIL_ARCHIVE_FOLDER`, else Archive). Returning null = the probe
   * could not decide (unconfigured account, IMAP error).
   */
  mailFolderCount?: (folder: string | null) => Promise<{ folder: string; count: number } | null>
  /** Adapter hook for `page_contains` (Browser). */
  browserContains?: (input: { url: string; selector: string; expect: string }) => Promise<boolean | null>
  /** Adapter hook for `git_diff_matches`; defaults to a read-only `git diff`. */
  gitChangedPaths?: (input: { cwd: string; ref: string; paths: string[]; timeoutMs: number }) => Promise<string[]>
  now?: () => Date
}

export type VerifyOverall = 'pass' | 'fail' | 'incomplete' | 'no-assertions'

export interface AssertionReport {
  assertionId: string
  kind: AssertionKind
  status: OutcomeStatus
  evidence: JsonObject
  checkedAt: string
}

export interface VerificationResult {
  taskId: string
  overall: VerifyOverall
  counts: { pass: number; fail: number; skipped: number }
  results: AssertionReport[]
  checkedAt: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const CONNECT_TIMEOUT_MS = 3_000

function sleeper(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function defaultGitChangedPaths(input: {
  cwd: string
  ref: string
  paths: string[]
  timeoutMs: number
}): Promise<string[]> {
  const args = ['diff', '--name-only', input.ref, '--', ...input.paths]
  const { stdout } = await execFileAsync('git', args, {
    cwd: input.cwd,
    timeout: input.timeoutMs,
    maxBuffer: 1_000_000,
  })
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

type PortState = 'open' | 'closed' | 'unknown'

function probePort(host: string, port: number, timeoutMs: number): Promise<PortState> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host, port })
    const finish = (state: PortState): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish('open'))
    socket.once('timeout', () => finish('unknown'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
        finish('closed')
        return
      }
      finish('unknown')
    })
  })
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(path)).digest('hex')
}

/** Evaluate one assertion; pure read-only (17 §8.5 rule 2). */
export async function evaluateAssertion(
  assertion: Pick<TaskAssertion, 'kind' | 'spec'>,
  context: VerifyContext = {},
): Promise<AssertionOutcome> {
  const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spec = assertion.spec

  switch (assertion.kind) {
    case 'exit_code': {
      const expected = spec.expected
      const observed = context.execExitCode ?? null
      if (observed === null) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'exit_code', expected, observed, reason: 'no recorded execution evidence' },
        }
      }
      return {
        status: observed === expected ? 'pass' : 'fail',
        evidence: { evaluator: 'exit_code', expected, observed },
      }
    }

    case 'file_exists': {
      const path = String(spec.path)
      try {
        const stat = await fs.stat(path)
        if (!stat.isFile()) {
          return { status: 'fail', evidence: { evaluator: 'file_exists', path, reason: 'not a regular file' } }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return { status: 'fail', evidence: { evaluator: 'file_exists', path, observed: 'missing' } }
        }
        return {
          status: 'skipped',
          evidence: { evaluator: 'file_exists', path, reason: `stat failed (${code ?? 'error'})`, transient: true },
        }
      }
      if (spec.sha256 === undefined) {
        return { status: 'pass', evidence: { evaluator: 'file_exists', path, observed: 'present' } }
      }
      const sha256 = await hashFile(path)
      return {
        status: sha256 === spec.sha256 ? 'pass' : 'fail',
        evidence: { evaluator: 'file_exists', path, expected: spec.sha256, observed: sha256 },
      }
    }

    case 'port_listening': {
      const host = String(spec.host)
      const port = Number(spec.port)
      const state = await probePort(host, port, Math.min(timeoutMs, CONNECT_TIMEOUT_MS))
      if (state === 'unknown') {
        return {
          status: 'skipped',
          evidence: { evaluator: 'port_listening', host, port, observed: state, transient: true },
        }
      }
      return {
        status: state === 'open' ? 'pass' : 'fail',
        evidence: { evaluator: 'port_listening', host, port, observed: state },
      }
    }

    case 'service_active': {
      const unit = String(spec.unit)
      if (context.serviceStatus === undefined) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'service_active', unit, reason: 'no SvcOps adapter mounted' },
        }
      }
      const observed = await context.serviceStatus(unit)
      if (observed === 'unknown') {
        return { status: 'skipped', evidence: { evaluator: 'service_active', unit, observed, transient: true } }
      }
      return {
        status: observed === 'active' ? 'pass' : 'fail',
        evidence: { evaluator: 'service_active', unit, observed },
      }
    }

    case 'unit_restarted': {
      const unit = String(spec.unit)
      if (context.unitState === undefined) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'unit_restarted', unit, reason: 'no SvcOps adapter mounted' },
        }
      }
      const startedAt = context.taskStartedAt ?? null
      const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt)
      if (Number.isNaN(startedMs)) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'unit_restarted', unit, reason: 'task has no startedAt baseline' },
        }
      }
      const state = await context.unitState(unit)
      if (state.activeState === 'unknown' || state.activeEnteredAtMs === null) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'unit_restarted', unit, observed: state.activeState, transient: true },
        }
      }
      // systemd reports whole seconds; floor both sides before comparing.
      const restarted = Math.floor(state.activeEnteredAtMs / 1000) >= Math.floor(startedMs / 1000)
      return {
        status: restarted ? 'pass' : 'fail',
        evidence: {
          evaluator: 'unit_restarted',
          unit,
          startedAt,
          activeState: state.activeState,
          observed: new Date(state.activeEnteredAtMs).toISOString(),
        },
      }
    }

    case 'mail_archived': {
      const folder = typeof spec.folder === 'string' ? spec.folder : null
      const expected = Number(spec.minCount ?? 1)
      if (context.mailFolderCount === undefined) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'mail_archived', folder, reason: 'no Mail adapter mounted' },
        }
      }
      const observed = await context.mailFolderCount(folder)
      if (observed === null) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'mail_archived', folder, observed: 'unavailable', transient: true },
        }
      }
      return {
        status: observed.count >= expected ? 'pass' : 'fail',
        evidence: {
          evaluator: 'mail_archived',
          folder: observed.folder,
          expected,
          observed: observed.count,
        },
      }
    }

    case 'http_status': {
      const url = String(spec.url)
      const expected = Number(spec.expected)
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
        })
        await response.body?.cancel()
        return {
          status: response.status === expected ? 'pass' : 'fail',
          evidence: { evaluator: 'http_status', url, expected, observed: response.status },
        }
      } catch (error) {
        return {
          status: 'skipped',
          evidence: {
            evaluator: 'http_status',
            url,
            expected,
            reason: error instanceof Error ? error.name : 'request failed',
            transient: true,
          },
        }
      }
    }

    case 'git_diff_matches': {
      const ref = String(spec.ref)
      const expect = spec.expect === 'unchanged' ? 'unchanged' : 'changed'
      const paths = Array.isArray(spec.paths) ? spec.paths.map(String) : []
      const cwd = context.cwd ?? process.cwd()
      const diff = context.gitChangedPaths ?? defaultGitChangedPaths
      let changed: string[]
      try {
        changed = await diff({ cwd, ref, paths, timeoutMs })
      } catch {
        return {
          status: 'skipped',
          evidence: { evaluator: 'git_diff_matches', ref, reason: 'git diff unavailable', transient: true },
        }
      }
      const present = new Set(changed.map((path) => path.replace(/^\.\//, '')))
      const hits = paths.length === 0
        ? changed.length > 0
        : paths.map((path) => present.has(path.replace(/^\.\//, '')))
      const pass = expect === 'changed'
        ? (paths.length === 0 ? hits === true : (hits as boolean[]).every(Boolean))
        : (paths.length === 0 ? hits === false : (hits as boolean[]).every((hit) => hit === false))
      return {
        status: pass ? 'pass' : 'fail',
        evidence: { evaluator: 'git_diff_matches', ref, expect, changed: changed.slice(0, 50) },
      }
    }

    case 'page_contains': {
      const url = String(spec.url)
      const selector = String(spec.selector)
      const expect = String(spec.expect)
      if (context.browserContains === undefined) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'page_contains', url, selector, reason: 'no Browser adapter mounted' },
        }
      }
      const observed = await context.browserContains({ url, selector, expect })
      if (observed === null) {
        return {
          status: 'skipped',
          evidence: { evaluator: 'page_contains', url, selector, observed: 'unavailable', transient: true },
        }
      }
      return {
        status: observed ? 'pass' : 'fail',
        evidence: { evaluator: 'page_contains', url, selector, expected: expect, observed },
      }
    }
  }

  return {
    status: 'skipped',
    evidence: { evaluator: 'unknown', reason: `unsupported assertion kind ${String(assertion.kind)}` },
  }
}

/** 17 §8.6: a transient failure is retested exactly once, never looped. */
async function evaluateWithRetry(
  assertion: Pick<TaskAssertion, 'kind' | 'spec'>,
  context: VerifyContext,
): Promise<AssertionOutcome> {
  const first = await evaluateAssertion(assertion, context)
  if (first.status === 'pass' || first.evidence.transient !== true) return first
  await sleeper(50)
  const second = await evaluateAssertion(assertion, context)
  return { status: second.status, evidence: { ...second.evidence, retried: true } }
}

function overallOf(results: AssertionReport[]): VerifyOverall {
  if (results.length === 0) return 'no-assertions'
  if (results.some((result) => result.status === 'fail')) return 'fail'
  if (results.some((result) => result.status === 'skipped')) return 'incomplete'
  return 'pass'
}

/**
 * Evaluate every assertion of a task, persist results, and append a
 * `task.verified` event. The task status is left untouched: completion is a
 * separate, gated step (`completeTask`).
 */
export async function verifyTask(
  store: TaskStore,
  taskId: string,
  context: VerifyContext = {},
): Promise<VerificationResult> {
  const task = store.getTask(taskId)
  if (task === null) throw new TaskError('invalid-task', `task ${taskId} not found`)
  const now = context.now ?? (() => new Date())
  // `unit_restarted` compares the unit's last `active` entry against task start,
  // so a "restart" that never happened can no longer pass on `activeState` alone.
  const resolved: VerifyContext = { ...context, taskStartedAt: task.startedAt }
  const assertions = store.listAssertions(taskId)

  const results: AssertionReport[] = []
  for (const assertion of assertions) {
    const outcome = await evaluateWithRetry(assertion, resolved)
    const checkedAt = now().toISOString()
    const redacted = redactDeep(outcome.evidence).value as JsonObject
    store.setAssertionResult(assertion.id, { status: outcome.status, evidence: redacted, checkedAt })
    results.push({
      assertionId: assertion.id,
      kind: assertion.kind,
      status: outcome.status,
      evidence: redacted,
      checkedAt,
    })
  }

  const checkedAt = now().toISOString()
  const overall = overallOf(results)
  const counts = {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  }
  store.appendEvent(taskId, 'task.verified', { overall, counts, checkedAt })

  return { taskId, overall, counts, results, checkedAt }
}

/**
 * Gate success on the Verifier: a task may only reach `succeeded` when every
 * assertion passed (or it declared none and is R0/R1). Failure/incomplete is
 * reported, never silently converted into success.
 */
export async function completeTask(
  store: TaskStore,
  taskId: string,
  context: VerifyContext & { summary?: string; evidenceLocator?: string | null } = {},
): Promise<{ task: Task; verification: VerificationResult }> {
  const task = store.getTask(taskId)
  if (task === null) throw new TaskError('invalid-task', `task ${taskId} not found`)
  if (task.status !== 'running') {
    throw new TaskError('invalid-transition', `complete requires status running, got ${task.status}`)
  }
  const assertions = store.listAssertions(taskId)
  if (requiresCriteria(task.riskLevel) && assertions.length === 0) {
    throw new TaskError('criteria-required', `${task.riskLevel} tasks cannot complete without assertions`)
  }

  const verification = await verifyTask(store, taskId, context)
  if (verification.overall === 'fail') {
    throw new TaskError(
      'verification-failed',
      `${verification.counts.fail} of ${verification.results.length} assertion(s) failed`,
    )
  }
  if (verification.overall === 'incomplete') {
    throw new TaskError(
      'verification-incomplete',
      `${verification.counts.skipped} assertion(s) could not be evaluated; mount the missing adapter or fix the target`,
    )
  }

  const summary = context.summary
    ?? (verification.overall === 'no-assertions'
      ? 'task completed without assertions (R0/R1)'
      : `task completed; ${verification.counts.pass} assertion(s) passed`)
  const completed = store.transition(taskId, {
    to: 'succeeded',
    summary,
    evidenceLocator: context.evidenceLocator ?? null,
  })
  return { task: completed, verification }
}
