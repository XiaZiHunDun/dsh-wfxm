/**
 * Real executor for ⑤'s worker (切片 B): spawn `dsh --profile <p> --json -`
 * and turn the NDJSON run events into an `ExecOutcome`.
 *
 * Design notes (read before changing):
 *
 * - The task prompt is `task.intent`, delivered on stdin (`-`) so no argv
 *   quoting or length limits apply. Slice AP appends `threadContext` after the
 *   intent (same stdin), so the intent always stays first. stdout carries
 *   NDJSON events, stderr carries diagnostics.
 *
 * - dsh exits 0 even when the run itself failed (e.g. MISSING_CREDENTIAL);
 *   the verdict comes from the `turn_end` event's `reason.kind`. Exit codes
 *   only classify process-level failures (crash / killed / spawn error).
 *
 * - One attempt = one checkpoint (deliverable boundary): the subprocess
 *   cannot join the parent's AsyncLocalStorage, so step attribution crosses
 *   the process boundary through env (`DSH_WFXM_TASK_ID` /
 *   `DSH_WFXM_CHECKPOINT_ID`). ④'s env resolver in the child stamps
 *   `file_preimages` from those. Finer in-run steps stay an in-process
 *   concern (`runWithCheckpoint`) and are out of scope here.
 *
 * - The checkpoint is begun at the top of `execute` (equivalent to "worker
 *   begins before calling execute") and closed committed/aborted with the
 *   outcome. A begin failure is loud (no child is spawned); a close failure
 *   is reported through `onError` but never masks the outcome — the work
 *   already happened.
 *
 * - Heartbeat loss means another worker owns the lease: the child is killed
 *   and a `conflict` outcome is returned; ⑤'s stale-lease check discards it.
 */

import { spawn } from 'node:child_process'

/** Structural twin of ⑤'s `FailureKind` (AR32: this module imports no ⑤ code). */
export type FailureKind =
  | 'transient'
  | 'permission_denied'
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'unknown'

export interface ExecSuccess {
  status: 'succeeded'
  summary: string
  evidenceLocator?: string | null
}

export interface ExecFailure {
  status: 'failed'
  summary: string
  failure: FailureKind
}

export type ExecOutcome = ExecSuccess | ExecFailure

/** Structural twin of the `Task` fields the executor reads. */
export interface ExecutorTaskRef {
  id: string
  intent: string
  projectId?: string | null
  riskLevel?: string
  /**
   * Slice AP: results already produced on the same thread. Appended after the
   * intent (never in front of it) so the actual request keeps priority.
   */
  threadContext?: string | null
}

/** Structural twin of ⑤'s `ExecHooks`. */
export interface ExecutorHooks {
  heartbeat(): boolean
  readonly attempt: number
  /** Aborted by the owner (`停止 <ref>`); the child is killed and the outcome is `conflict`. */
  signal?: AbortSignal
}

export type TaskExecutorFn = (
  task: ExecutorTaskRef,
  hooks: ExecutorHooks,
) => Promise<ExecOutcome>

/** Structural twin of ⑤'s checkpoint store API (AR33: injected by the host). */
export interface CheckpointPort {
  beginCheckpoint(input: { taskId: string; label?: string | null }): { id: string }
  closeCheckpoint(id: string, status: 'committed' | 'aborted'): unknown
}

export interface DshExecutorOptions {
  /** dsh binary; default `dsh` (resolved through the child's PATH). */
  dshBin?: string
  /** dsh profile; default `headless`. */
  profile?: string
  /** Extra env for the child, merged over `process.env` (attribution keys win). */
  env?: Record<string, string>
  /** Hard wall-clock limit per attempt; a timeout is a transient failure. */
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL when killing the child. */
  killGraceMs?: number
  /** Where the child runs; async is allowed (worktree create + prepare). */
  workdirResolver?: (task: ExecutorTaskRef) => string | null | Promise<string | null>
  /** Fallback cwd when no resolver is given. Defaults to `process.cwd()`. */
  defaultWorkdir?: string
  /** When present, each attempt is wrapped in one checkpoint. */
  checkpoints?: CheckpointPort | null
  /** Heartbeat cadence while the child runs. */
  heartbeatMs?: number
  /** Summaries longer than this are truncated (receipt-sized, not logs). */
  maxSummaryChars?: number
  /** Non-fatal internal errors (e.g. checkpoint close) surface here. */
  onError?: (error: unknown) => void
}

export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_KILL_GRACE_MS = 5_000
export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_MAX_SUMMARY_CHARS = 4_000

/** Network/limits that justify a backoff retry (13 §3.3). */
const TRANSIENT_PATTERN =
  /rate.?limit|too many requests|\b429\b|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|network error|timed?\s?out|temporarily unavailable|overloaded|502 bad gateway|503 service/i

/** Credential/auth problems are terminal and must reach a human, not a retry. */
const CREDENTIAL_PATTERN =
  /missing_credential|no api key|invalid api key|unauthorized|\b401\b|\b403\b|authentication|forbidden/i

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

function classifyText(text: string): FailureKind | null {
  if (CREDENTIAL_PATTERN.test(text)) return 'permission_denied'
  if (TRANSIENT_PATTERN.test(text)) return 'transient'
  return null
}

interface RunEvent {
  type?: unknown
  phase?: unknown
  reason?: { kind?: unknown; error?: { code?: unknown; message?: unknown } }
  sessionId?: unknown
  text?: unknown
}

export function createDshExecutor(options: DshExecutorOptions = {}): TaskExecutorFn {
  const dshBin = options.dshBin ?? 'dsh'
  const profile = options.profile ?? 'headless'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const maxSummary = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS
  const checkpoints = options.checkpoints ?? null

  return async function execute(task, hooks) {
    const intent = task.intent?.trim() ?? ''
    if (intent.length === 0) {
      return { status: 'failed', failure: 'invalid_input', summary: 'task has an empty intent; nothing to run' }
    }
    // Slice AP: context is an appendix, so the intent always comes first.
    const threadContext = task.threadContext?.trim() ?? ''
    const prompt = threadContext.length === 0 ? intent : `${intent}\n\n${threadContext}`

    let cwd: string
    if (options.workdirResolver !== undefined) {
      let resolved: string | null
      try {
        // Isolation may need to create a worktree or run a prepare command, so
        // the resolver is allowed to be async; refusing still returns null/''.
        resolved = await options.workdirResolver(task)
      } catch (error) {
        return {
          status: 'failed',
          failure: 'unknown',
          summary: truncate(`workdir resolver threw: ${error instanceof Error ? error.message : String(error)}`, maxSummary),
        }
      }
      if (resolved === null || resolved.trim() === '') {
        return {
          status: 'failed',
          failure: 'not_found',
          summary: truncate(`no workspace resolved for task ${task.id} (project ${task.projectId ?? 'none'})`, maxSummary),
        }
      }
      cwd = resolved
    } else {
      cwd = options.defaultWorkdir ?? process.cwd()
    }

    return new Promise<ExecOutcome>((resolve) => {
      const fail = (failure: FailureKind, summary: string): void => {
        resolve({ status: 'failed', failure, summary: truncate(summary, maxSummary) })
      }

      // One attempt = one checkpoint. Loud on begin: without the boundary the
      // attempt's writes could not be attributed to a rollback step.
      let checkpointId: string | null = null
      if (checkpoints !== null) {
        try {
          checkpointId = checkpoints.beginCheckpoint({
            taskId: task.id,
            label: `attempt ${hooks.attempt}`,
          }).id
        } catch (error) {
          fail('unknown', `checkpoint begin failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }

      const closeCheckpoint = (status: 'committed' | 'aborted'): void => {
        if (checkpoints === null || checkpointId === null) return
        try {
          checkpoints.closeCheckpoint(checkpointId, status)
        } catch (error) {
          options.onError?.(error)
        }
      }

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...(options.env ?? {}),
        DSH_WFXM_TASK_ID: task.id,
        DSH_WFXM_ATTEMPT: String(hooks.attempt),
      }
      if (checkpointId !== null) env.DSH_WFXM_CHECKPOINT_ID = checkpointId
      // ③ gate hand-off: R2/R3 tasks only reach `exec` after the owner approved
      // the plan, so the child may answer tool-level approvals for that task.
      if (task.riskLevel === 'R2' || task.riskLevel === 'R3') {
        env.DSH_WFXM_APPROVED_LEVEL = task.riskLevel
      } else {
        delete env.DSH_WFXM_APPROVED_LEVEL
      }

      let child
      try {
        child = spawn(dshBin, ['--profile', profile, '--json', '-'], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        closeCheckpoint('aborted')
        fail('unknown', `spawn ${dshBin} threw: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      let sessionId: string | null = null
      let finalText: string | null = null
      let textFallback: string[] = []
      let runError: { code: string; message: string } | null = null
      let stderrText = ''
      let lineBuffer = ''
      let timedOut = false
      let leaseLost = false
      let cancelled = false
      let spawnError: NodeJS.ErrnoException | null = null
      let settled = false

      const killTimer = { term: null as NodeJS.Timeout | null, kill: null as NodeJS.Timeout | null }

      const killChild = (): void => {
        if (child.exitCode !== null || child.killed) return
        child.kill('SIGTERM')
        killTimer.kill = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, killGraceMs)
        killTimer.kill.unref?.()
      }

      const heartbeat = setInterval(() => {
        if (!hooks.heartbeat()) {
          leaseLost = true
          killChild()
        }
      }, heartbeatMs)
      heartbeat.unref?.()

      // Owner "停止": abort means kill the child now; `close` reports `conflict`
      // so the worker can discard the outcome instead of settling it.
      const onAbort = (): void => {
        cancelled = true
        killChild()
      }
      if (hooks.signal !== undefined) {
        if (hooks.signal.aborted) onAbort()
        else hooks.signal.addEventListener('abort', onAbort, { once: true })
      }

      killTimer.term = setTimeout(() => {
        timedOut = true
        killChild()
      }, timeoutMs)
      killTimer.term.unref?.()

      const handleLine = (line: string): void => {
        const trimmed = line.trim()
        if (trimmed.length === 0) return
        let event: RunEvent
        try {
          event = JSON.parse(trimmed) as RunEvent
        } catch {
          return // dsh prints non-JSON noise on stdout occasionally; tolerate it.
        }
        if (event.type === 'session' && typeof event.sessionId === 'string') {
          sessionId = event.sessionId
        } else if (event.type === 'text' && typeof event.text === 'string') {
          textFallback.push(event.text)
        } else if (event.type === 'final' && typeof event.text === 'string') {
          finalText = event.text
        } else if (
          event.type === 'status'
          && event.phase === 'turn_end'
          && event.reason?.kind === 'error'
        ) {
          const code = event.reason.error?.code
          const message = event.reason.error?.message
          runError = {
            code: typeof code === 'string' ? code : 'unknown',
            message: typeof message === 'string' ? message : 'run failed',
          }
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString('utf8')
        let index = lineBuffer.indexOf('\n')
        while (index >= 0) {
          handleLine(lineBuffer.slice(0, index))
          lineBuffer = lineBuffer.slice(index + 1)
          index = lineBuffer.indexOf('\n')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString('utf8')
        if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        spawnError = error
      })
      child.stdin?.on('error', () => {
        // EPIPE: the child died before reading the prompt; `close` settles it.
      })
      child.stdin?.write(`${prompt}\n`)
      child.stdin?.end()

      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearInterval(heartbeat)
        if (killTimer.term !== null) clearTimeout(killTimer.term)
        if (killTimer.kill !== null) clearTimeout(killTimer.kill)
        hooks.signal?.removeEventListener('abort', onAbort)
        if (lineBuffer.trim().length > 0) handleLine(lineBuffer)

        const evidenceLocator = sessionId === null ? null : `dsh-session:${sessionId}`

        if (spawnError !== null) {
          closeCheckpoint('aborted')
          if (spawnError.code === 'ENOENT') {
            fail('not_found', `dsh binary not found: ${dshBin}`)
          } else {
            fail('unknown', `spawn ${dshBin} failed: ${spawnError.message}`)
          }
          return
        }
        if (cancelled) {
          closeCheckpoint('aborted')
          fail('conflict', 'cancelled by owner')
          return
        }
        if (leaseLost) {
          closeCheckpoint('aborted')
          fail('conflict', 'lease lost while the child ran; killed the attempt')
          return
        }
        if (timedOut) {
          closeCheckpoint('aborted')
          fail('transient', `dsh run timed out after ${timeoutMs}ms and was killed`)
          return
        }
        if (runError !== null) {
          closeCheckpoint('aborted')
          const kind = classifyText(`${runError.code} ${runError.message}`) ?? 'unknown'
          fail(kind, `dsh run error ${runError.code}: ${runError.message}`)
          return
        }
        if (code !== 0) {
          closeCheckpoint('aborted')
          const detail = tail(stderrText)
          const kind = classifyText(detail) ?? 'unknown'
          fail(kind, `dsh exited ${signal === null ? `code ${code}` : `signal ${signal}`}: ${detail || '(no stderr)'}`)
          return
        }

        closeCheckpoint('committed')
        const text = finalText ?? (textFallback.length > 0 ? textFallback.join('') : null)
        resolve({
          status: 'succeeded',
          summary: truncate(text === null || text.trim() === '' ? '(no output)' : text.trim(), maxSummary),
          evidenceLocator,
        })
      })
    })
  }
}
