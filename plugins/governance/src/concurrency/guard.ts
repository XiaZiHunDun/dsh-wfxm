import { createHash } from 'node:crypto'
import { KeyedMutex } from './mutex.js'
import { createSnapshotStore, fingerprint, sameFingerprint, snapshotKey } from './snapshot.js'
import {
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
  requestedPath,
  resolveTarget,
  sessionIdentity,
  sessionWorkspace,
} from './tools.js'
import type { DecisionStore } from '../policy/store.js'

interface Logger {
  warn?(...args: unknown[]): void
}

interface ContextLike {
  on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean }): () => void
  logger?: Logger
}

interface ExecutionLike {
  callId: string
  name: string
  arguments: unknown
  agent?: unknown
  signal?: AbortSignal
}

interface ResultLike {
  isError?: boolean
}

export interface ConcurrencyOptions {
  /** Serialize file mutations per workspace and check stale snapshots first. */
  enabled: boolean
  /** Consecutive conflicts after which the session is reported as blocked. */
  conflictLimit: number
}

/**
 * V2 concurrency policy.
 *
 * - `tools/execute` wraps file mutations in a per-workspace mutex (reads stay
 *   parallel) and compares the file against the snapshot this session last
 *   observed. A mismatch refuses the write so the model must re-read.
 * - `tools/post-execute` records a fresh snapshot after a successful read.
 * - Consecutive conflicts are counted per session; reaching the limit is
 *   recorded as `workspace-conflict-repeat` and logged for the notification
 *   hook (task runtime arrives with Step 4).
 *
 * The mutex is process-local: one dsh process per deployment is the current
 * assumption; a second process would need a file lock.
 * @param ctx - plugin context.
 * @param options - policy knobs.
 * @param decisions - decision sink shared with the S1 gate.
 */
export function installConcurrency(
  ctx: ContextLike,
  options: ConcurrencyOptions,
  decisions: DecisionStore,
): void {
  if (!options.enabled) return

  const mutex = new KeyedMutex()
  const snapshots = createSnapshotStore()
  const conflicts = new Map<string, number>()

  ctx.on('tools/execute', async (exec: ExecutionLike, next: () => Promise<unknown>) => {
    if (!FILE_WRITE_TOOLS.has(exec.name)) return next()
    const requested = requestedPath(exec.name, exec.arguments)
    if (requested === null) return next()

    const session = sessionIdentity(exec.agent)
    const workspace = sessionWorkspace(ctx, exec.agent)
    const target = resolveTarget(workspace, requested)
    const lockKey = workspace ?? target

    return mutex.run(lockKey, exec.signal, async () => {
      const prior = snapshots.get(snapshotKey(session, target))
      if (prior !== undefined) {
        const current = await fingerprint(target)
        const unchanged = prior === null
          ? current === null
          : current !== null && sameFingerprint(prior, current)
        if (!unchanged) {
          const count = (conflicts.get(session) ?? 0) + 1
          conflicts.set(session, count)
          const reason = `文件在读取后状态已变化（可能被其他会话修改、删除或创建）：${target}`
          decisions.record({
            correlationId: exec.callId,
            ruleId: count >= options.conflictLimit ? 'workspace-conflict-repeat' : 'workspace-conflict',
            rulesetVersion: 'v2',
            inputDigest: createHash('sha256').update(JSON.stringify(exec.arguments ?? null)).digest('hex'),
            verdict: 'deny',
            reason,
          })
          if (count >= options.conflictLimit) {
            ctx.logger?.warn?.(
              `[governance] session ${session} hit ${count} consecutive write conflicts; ` +
                `pause and notify owner (task runtime pending). Last target: ${target}`,
            )
          }
          throw new Error(`${reason}，请重新读取后再写入。`)
        }
      }

      const result = await next()
      if ((result as ResultLike | undefined)?.isError !== true) {
        conflicts.set(session, 0)
        snapshots.record(snapshotKey(session, target), await fingerprint(target))
      }
      return result
    })
  })

  ctx.on('tools/post-execute', async (exec: ExecutionLike, result: ResultLike, next: () => Promise<unknown>) => {
    if (FILE_READ_TOOLS.has(exec.name) && result?.isError !== true && exec.signal?.aborted !== true) {
      const requested = requestedPath(exec.name, exec.arguments)
      if (requested !== null) {
        const session = sessionIdentity(exec.agent)
        const target = resolveTarget(sessionWorkspace(ctx, exec.agent), requested)
        snapshots.record(snapshotKey(session, target), await fingerprint(target))
      }
    }
    return next()
  })

  ctx.on('dispose', () => {
    snapshots.clear()
    conflicts.clear()
  })
}
