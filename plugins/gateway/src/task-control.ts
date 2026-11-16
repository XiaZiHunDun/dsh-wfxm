/**
 * Control commands: stop / pause / resume / rollback / status (11 §5.3, 15 §9.6).
 *
 * ① resolves the target task from the live anchors and calls ⑤'s module API
 * through the injected port; ① never writes ⑤'s tables (AR33). `status` only
 * reports, it never changes state. A finished task is never paused/cancelled;
 * resume of a finished task waits for ③'s Grant re-check (AR37).
 * `rollback` is the exception that *needs* a finished or running task: it undoes
 * the task's own writes (⑤ `task_rollback`, R1), so the live gate does not apply.
 */

export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'rollback'

/** `TaskControlPort` as composed by the host on top of ⑤'s module API. */
export interface TaskControlPort {
  control(input: {
    taskId: string
    action: TaskControlAction
    /** Only for `rollback`: one step instead of the whole task. */
    checkpointId?: string
  }): { status: string }
}

export type ControlSkipReason =
  | 'no-port'
  | 'no-task'
  | 'status-only'
  | 'not-live'

export interface TaskControlReport {
  executed: boolean
  action: TaskControlAction | null
  status: string | null
  skipped: ControlSkipReason | null
}

export interface TaskControlInput {
  command: string
  taskId: string | null
  /** False for terminal states; only resume-after-Grant may go back to work. */
  live: boolean
  status: string | null
  /** `rollback` only: the step to undo; absent = whole task. */
  checkpointId?: string | null
}

const ACTION_BY_COMMAND: Record<string, TaskControlAction> = {
  stop: 'cancel',
  pause: 'pause',
  resume: 'resume',
  rollback: 'rollback',
}

export function controlTask(
  port: TaskControlPort | null,
  input: TaskControlInput,
): TaskControlReport {
  const action = ACTION_BY_COMMAND[input.command]
  if (action === undefined) {
    return {
      executed: false,
      action: null,
      status: input.status,
      skipped: 'status-only',
    }
  }
  if (input.taskId === null) {
    return { executed: false, action, status: input.status, skipped: 'no-task' }
  }
  if (port === null) {
    return { executed: false, action, status: input.status, skipped: 'no-port' }
  }
  if (action === 'rollback') {
    // Undo works on finished tasks too (that is the common case); only the
    // target task must exist, which `taskId === null` already covers.
    const result = port.control({
      taskId: input.taskId,
      action,
      ...input.checkpointId === null || input.checkpointId === undefined
        ? {}
        : { checkpointId: input.checkpointId },
    })
    return { executed: true, action, status: result.status, skipped: null }
  }
  if (!input.live) {
    return { executed: false, action, status: input.status, skipped: 'not-live' }
  }
  const result = port.control({ taskId: input.taskId, action })
  return { executed: true, action, status: result.status, skipped: null }
}
