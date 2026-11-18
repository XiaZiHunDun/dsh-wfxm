/**
 * Task worker (13 §3.3 / §3.4): the only thing that starts a task on its own.
 *
 * A worker claims a leased task from the store, runs an injected executor and
 * settles the outcome. It never reads ⑤'s tables on behalf of others and it
 * never decides product policy: retry grading comes from the port error
 * classification below, and R3 work is refused unless a snapshot was taken.
 */

import { runWithTaskContext } from './context.js'
import type { Task } from './model.js'
import { DEFAULT_RESOURCE_TTL_SEC, declaredResources } from './resource-locks.js'
import type { AcquireResourceLocksResult, TaskStore } from './store.js'
import { completeTask, type VerifyContext } from './verify.js'

/** Port error classes (15 §五); the worker maps them to task-level actions. */
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

export interface ExecHooks {
  /** Extend the lease; false means another worker owns the task now. */
  heartbeat(): boolean
  /** 1-based attempt number of this run. */
  readonly attempt: number
  /** Aborted when the owner stops the task; the executor must kill its child. */
  signal?: AbortSignal
}

export type TaskExecutor = (task: Task, hooks: ExecHooks) => Promise<ExecOutcome> | ExecOutcome

/** ⑦ 运维域 provides snapshots; a failure refuses execution (13 §3.4). */
export interface SnapshotPort {
  capture(task: Task): Promise<{ snapshotId: string; baselineRef?: string | null }>
}

export type WorkerSkipReason
  = | 'idle'
    | 'snapshot-refused'
    | 'stale-lease'
    | 'resource-conflict'
    | 'cancelled'
    | 'paused'

export interface TaskRunReport {
  taskId: string | null
  outcome: 'succeeded' | 'failed' | 'retried' | 'skipped'
  failure: FailureKind | null
  skipped: WorkerSkipReason | null
  attempt: number | null
  /** Earliest re-claim time for a retried task. */
  wakeAt: string | null
}

export interface TaskWorkerOptions {
  store: TaskStore
  execute: TaskExecutor
  /** Required for R3 tasks; without it every R3 claim is refused. */
  snapshot?: SnapshotPort | null
  /**
   * 17 §8.5 verifier context (adapters / cwd). Success is gated on the Verifier:
   * an executor saying "succeeded" is not enough (13 §3.3).
   */
  verify?: VerifyContext
  owner?: string
  leaseMs?: number
  heartbeatMs?: number
  /** Backoff ladder for transient failures; the last value repeats. */
  backoffMs?: readonly number[]
  /**
   * B4-b Phase 3 (Slice Y): acquire `task.plan.resources` before execution and
   * park the task when a key is held. Off by default (`DSH_WFXM_RESOURCE_LOCKS`),
   * so tasks without the flag behave exactly as before.
   */
  resourceLocks?: boolean
  /** Resource lease TTL; refreshed on every worker heartbeat. */
  resourceTtlSec?: number
  /** Delay before a resource-blocked task is retried. */
  resourceRetryMs?: number
  now?: () => Date
  onError?: (error: unknown) => void
}

export const DEFAULT_LEASE_MS = 60_000
export const DEFAULT_HEARTBEAT_MS = 15_000
export const DEFAULT_RESOURCE_RETRY_MS = 5_000
/** 13 §3.3 指数退避；attempt 超出表长时取最后一档。 */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000]

/** Non-retryable kinds go straight to a human-visible terminal (13 §3.3). */
export const RETRYABLE_FAILURES: readonly FailureKind[] = ['transient']

function classify(error: unknown): FailureKind {
  const kind = (error as { kind?: unknown } | null)?.kind
  if (
    kind === 'transient'
    || kind === 'permission_denied'
    || kind === 'not_found'
    || kind === 'invalid_input'
    || kind === 'conflict'
  ) {
    return kind
  }
  return 'unknown'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : null
}

function idle(): TaskRunReport {
  return { taskId: null, outcome: 'skipped', failure: null, skipped: 'idle', attempt: null, wakeAt: null }
}

export interface TaskWorker {
  /** Claim and settle at most one task. */
  runOnce(): Promise<TaskRunReport>
  /** Reclaim expired leases without claiming anything. */
  recover(): { requeued: string[]; failed: string[] }
  /** Abort the active attempt for `taskId`; true when one was running. */
  cancel(taskId: string): boolean
  start(options?: { intervalMs?: number }): void
  stop(): void
  readonly owner: string
}

export function createTaskWorker(options: TaskWorkerOptions): TaskWorker {
  const { store, execute, snapshot = null } = options
  const owner = options.owner ?? `worker-${Math.random().toString(36).slice(2, 10)}`
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS
  const now = options.now ?? (() => new Date())

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  /** taskId → the attempt currently inside `execute` (owner "停止"). */
  const activeAttempts = new Map<string, AbortController>()

  const backoffFor = (attempt: number): number =>
    backoff[Math.min(Math.max(attempt - 1, 0), backoff.length - 1)]

  async function settle(task: Task, outcome: ExecOutcome, wakeAt: string | null): Promise<TaskRunReport> {
    if (outcome.status === 'succeeded') {
      // 13 §3.3 / 17 §8.5: the executor's "succeeded" is a claim, not a verdict.
      // Only the Verifier may move a task to `succeeded`; a failure here is a
      // terminal failure (never retried) with the verifier code as the reason.
      try {
        // A worktree task's assertions must see the checkout that actually ran;
        // re-read the row because isolation is written during execution (the
        // claimed task object predates the worktree).
        const latest = store.getTask(task.id) ?? task
        const verify = options.verify === undefined
          ? undefined
          : { ...options.verify, cwd: latest.worktreePath ?? options.verify.cwd }
        await completeTask(store, task.id, {
          ...verify ?? {},
          summary: outcome.summary,
          ...outcome.evidenceLocator === undefined ? {} : { evidenceLocator: outcome.evidenceLocator },
        })
        return {
          taskId: task.id,
          outcome: 'succeeded',
          failure: null,
          skipped: null,
          attempt: task.attempt,
          wakeAt: null,
        }
      } catch (error) {
        try {
          store.transition(task.id, {
            to: 'failed',
            summary: messageOf(error),
            reason: errorCodeOf(error) ?? 'verification-failed',
          })
        } catch (transitionError) {
          options.onError?.(transitionError)
        }
        return {
          taskId: task.id,
          outcome: 'failed',
          failure: 'unknown',
          skipped: null,
          attempt: task.attempt,
          wakeAt: null,
        }
      }
    }

    const retryable = RETRYABLE_FAILURES.includes(outcome.failure)
    if (retryable && task.attempt < task.maxAttempts) {
      const delayMs = backoffFor(task.attempt)
      const requeued = store.requeueTask({
        taskId: task.id,
        owner,
        delayMs,
        reason: `${outcome.failure}: ${outcome.summary}`,
        now: now(),
      })
      return {
        taskId: task.id,
        outcome: 'retried',
        failure: outcome.failure,
        skipped: null,
        attempt: requeued.attempt,
        wakeAt: wakeAt ?? new Date(now().getTime() + delayMs).toISOString(),
      }
    }

    store.transition(task.id, {
      to: 'failed',
      summary: outcome.summary,
      reason: retryable
        ? `${outcome.failure}: attempts exhausted (${task.attempt}/${task.maxAttempts})`
        : outcome.failure,
    })
    return {
      taskId: task.id,
      outcome: 'failed',
      failure: outcome.failure,
      skipped: null,
      attempt: task.attempt,
      wakeAt: null,
    }
  }

  async function runOnce(): Promise<TaskRunReport> {
    store.recoverExpiredLeases({ now: now() })
    const task = store.claimTask({ owner, leaseMs, now: now() })
    if (task === null) return idle()

    const stale = (): TaskRunReport => ({
      taskId: task.id,
      outcome: 'skipped',
      failure: null,
      skipped: 'stale-lease',
      attempt: task.attempt,
      wakeAt: null,
    })

    // 13 §3.4: R3 must snapshot first; a failure refuses execution, it never
    // means "do it anyway".
    if (task.riskLevel === 'R3') {
      if (snapshot === null) {
        store.transition(task.id, {
          to: 'failed',
          summary: 'R3 refused: no snapshot port configured',
          reason: 'snapshot-unavailable',
        })
        return {
          taskId: task.id,
          outcome: 'failed',
          failure: 'unknown',
          skipped: 'snapshot-refused',
          attempt: task.attempt,
          wakeAt: null,
        }
      }
      try {
        const captured = await snapshot.capture(task)
        store.appendEvent(task.id, 'task.snapshot', {
          snapshotId: captured.snapshotId,
          baselineRef: captured.baselineRef ?? null,
        })
      } catch (error) {
        store.transition(task.id, {
          to: 'failed',
          summary: `snapshot failed: ${messageOf(error)}`,
          reason: 'snapshot-failed',
        })
        return {
          taskId: task.id,
          outcome: 'failed',
          failure: 'unknown',
          skipped: 'snapshot-refused',
          attempt: task.attempt,
          wakeAt: null,
        }
      }
    }

    // Slice Y: declared non-file resources are leased around this execution.
    // Contention parks the task without consuming an attempt (15 §10.4).
    const resourceTtlSec = options.resourceTtlSec ?? DEFAULT_RESOURCE_TTL_SEC
    const resourceRetryMs = options.resourceRetryMs ?? DEFAULT_RESOURCE_RETRY_MS
    let resources: string[] = []
    try {
      if (options.resourceLocks === true) resources = declaredResources(task.plan)
    } catch (error) {
      store.transition(task.id, {
        to: 'failed',
        summary: `resource lease failed: ${messageOf(error)}`,
        reason: 'resource-invalid',
      })
      return {
        taskId: task.id,
        outcome: 'failed',
        failure: classify(error),
        skipped: null,
        attempt: task.attempt,
        wakeAt: null,
      }
    }

    let lockIds: string[] = []
    let locksLost = false
    if (resources.length > 0) {
      let grant: AcquireResourceLocksResult
      try {
        grant = store.acquireResourceLocks({
          taskId: task.id,
          keys: resources,
          ttlSec: resourceTtlSec,
          owner,
          now: now(),
        })
      } catch (error) {
        store.transition(task.id, {
          to: 'failed',
          summary: `resource lease failed: ${messageOf(error)}`,
          reason: 'resource-invalid',
        })
        return {
          taskId: task.id,
          outcome: 'failed',
          failure: classify(error),
          skipped: null,
          attempt: task.attempt,
          wakeAt: null,
        }
      }
      if (grant.acquired.length === 0) {
        const deferred = store.deferTask({
          taskId: task.id,
          owner,
          delayMs: resourceRetryMs,
          reason: 'resource-conflict',
          blocking: grant.conflicts,
          now: now(),
        })
        return {
          taskId: task.id,
          outcome: 'skipped',
          failure: null,
          skipped: 'resource-conflict',
          attempt: deferred.attempt,
          wakeAt: new Date(now().getTime() + resourceRetryMs).toISOString(),
        }
      }
      lockIds = grant.acquired.map((lock) => lock.id)
    }

    // One keep-alive covers both the task lease and its resource leases: losing
    // either must stop the executor (its heartbeat returns false).
    const keepAlive = (): boolean => {
      if (!store.renewLease({ taskId: task.id, owner, leaseMs, now: now() })) return false
      if (lockIds.length === 0) return true
      try {
        const beatLocks = store.heartbeatResourceLocks({
          lockIds,
          ttlSec: resourceTtlSec,
          now: now(),
        })
        if (beatLocks.extended !== lockIds.length) {
          locksLost = true
          return false
        }
        return true
      } catch (error) {
        options.onError?.(error)
        locksLost = true
        return false
      }
    }

    const beat = setInterval(() => {
      keepAlive()
    }, heartbeatMs)
    beat.unref?.()

    let outcome: ExecOutcome
    const controller = new AbortController()
    activeAttempts.set(task.id, controller)
    try {
      // Everything the executor does (including the tool calls it dispatches)
      // inherits this task id, so ④ can stamp pre-images (13 §3.4).
      outcome = await runWithTaskContext(
        { taskId: task.id, projectId: task.projectId, attempt: task.attempt, checkpointId: null },
        () => execute(task, {
          attempt: task.attempt,
          heartbeat: keepAlive,
          signal: controller.signal,
        }),
      )
    } catch (error) {
      outcome = { status: 'failed', summary: messageOf(error), failure: classify(error) }
    } finally {
      clearInterval(beat)
      activeAttempts.delete(task.id)
    }

    // Another worker may have taken over while we ran; never overwrite it.
    // A cancelled/paused row has already had its lease cleared by the
    // transition, so that case is reported below instead of `stale-lease`.
    const latest = store.getTask(task.id)
    if (latest?.leaseOwner !== owner && latest?.status !== 'cancelled' && latest?.status !== 'paused') {
      // Owner steer (Slice AO) moved the row back to `queued` and cleared the
      // lease; the aborted attempt must release what it had leased too.
      try {
        store.releaseTaskResourceLocks(task.id)
      } catch (error) {
        options.onError?.(error)
      }
      return stale()
    }

    // Owner "停止" / watchdog pause: the row already left `running`, so settling
    // now would attempt cancelled|paused → succeeded/failed. Release and skip.
    if (latest?.status === 'cancelled' || latest?.status === 'paused') {
      try {
        store.releaseTaskResourceLocks(task.id)
      } catch (error) {
        options.onError?.(error)
      }
      return {
        taskId: task.id,
        outcome: 'skipped',
        failure: null,
        skipped: latest.status,
        attempt: task.attempt,
        wakeAt: null,
      }
    }

    // A lost resource lease means another task may own the port / DB / unit
    // now; the attempt must not be reported as success.
    if (locksLost) {
      outcome = { status: 'failed', summary: 'resource lease lost during execution', failure: 'conflict' }
    }

    // 15 §10.4: resource leases live with execution, not with the task row.
    // Released only after the Verifier has seen the outcome.
    const report = await settle(task, outcome, null)
    try {
      store.releaseTaskResourceLocks(task.id)
    } catch (error) {
      options.onError?.(error)
    }
    return report
  }

  return {
    owner,
    runOnce,
    recover: () => store.recoverExpiredLeases({ now: now() }),
    cancel(taskId) {
      const controller = activeAttempts.get(taskId)
      if (controller === undefined) return false
      controller.abort()
      return true
    },
    start(startOptions) {
      if (timer !== null) return
      const intervalMs = startOptions?.intervalMs ?? 1_000
      timer = setInterval(() => {
        if (running) return
        running = true
        runOnce()
          .catch((error) => options.onError?.(error))
          .finally(() => {
            running = false
          })
      }, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
