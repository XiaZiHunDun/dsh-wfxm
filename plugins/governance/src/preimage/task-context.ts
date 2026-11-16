/**
 * Task attribution for pre-images (13 §3.4 步级回滚).
 *
 * ④ must not import ⑤: the gate would drag the task runtime into every mount.
 * The host bridges the two once, after both plugins are mounted:
 *
 *   import { currentTaskContext } from '@dsh-wfxm/tasks'
 *   import { setTaskContextResolver } from '@dsh-wfxm/governance'
 *   setTaskContextResolver(currentTaskContext)
 *
 * A missing resolver — or one that throws — means "no task". The pre-image is
 * still captured: rollback by tool call must not depend on attribution, or the
 * safety net would disappear exactly when attribution breaks.
 */

/** Structural twin of ⑤'s `TaskContext`; only these two fields are used. */
export interface TaskContextRef {
  taskId: string
  /** Open step boundary; null/absent outside a step. */
  checkpointId?: string | null
}

export type TaskContextResolver = () => TaskContextRef | null

/**
 * Env bridge for subprocess executors (切片 B): AsyncLocalStorage cannot cross
 * a process boundary, so a worker that spawns `dsh headless` exports
 * `DSH_WFXM_TASK_ID` / `DSH_WFXM_CHECKPOINT_ID`; the governance mount inside
 * that child reads them here. Missing/empty values mean "no task" — the
 * pre-image is still captured, only the attribution is absent.
 */
export function createEnvTaskContextResolver(
  env: Record<string, string | undefined> = process.env,
): TaskContextResolver {
  return () => {
    const taskId = env.DSH_WFXM_TASK_ID
    if (typeof taskId !== 'string' || taskId.length === 0) return null
    const checkpointId = env.DSH_WFXM_CHECKPOINT_ID
    return {
      taskId,
      checkpointId: typeof checkpointId === 'string' && checkpointId.length > 0 ? checkpointId : null,
    }
  }
}

let resolver: TaskContextResolver | null = null

/** Wire ⑤'s ambient task context in; `null` detaches it again. */
export function setTaskContextResolver(next: TaskContextResolver | null): void {
  resolver = next
}

export function resolveTaskContext(): { taskId: string; checkpointId: string | null } | null {
  if (resolver === null) return null
  try {
    const ref = resolver()
    if (ref === null || typeof ref.taskId !== 'string' || ref.taskId.length === 0) return null
    const checkpointId = typeof ref.checkpointId === 'string' && ref.checkpointId.length > 0
      ? ref.checkpointId
      : null
    return { taskId: ref.taskId, checkpointId }
  } catch {
    return null
  }
}
