/**
 * Step-level rollback (13 §3.4). ⑤ records the step boundaries and drives the
 * rollback, but the files belong to ⑦: the host injects a `CheckpointRollbackPort`
 * (⑦ ships `createPreimageRollbackPort`), so ⑤ never imports ⑦ (AR33).
 *
 * The trigger is explicit — a tool call / control command — never automatic:
 * reversing a step changes the workspace and must be attributable in the trail.
 * `open` checkpoints touched by the rollback are closed as `aborted`, so a crash
 * mid-task does not leave half-open steps behind.
 */

import { TaskError, type Task, type TaskCheckpoint } from './model.js'
import type { TaskStore } from './store.js'

/** Structural twin of ⑦'s pre-image rollback (AR32: capability verbs only). */
export interface CheckpointRollbackPort {
  rollback(input: { taskId: string; checkpointId?: string }): Array<{
    path: string
    state: 'present' | 'absent'
  }>
}

export interface RollbackInput {
  store: TaskStore
  port: CheckpointRollbackPort
  taskId: string
  /** Omit to roll back every write of the task (R2/R3 tasks usually pass one). */
  checkpointId?: string
  reason?: string
}

export interface RollbackResult {
  taskId: string
  /** null = whole task. */
  checkpointId: string | null
  restored: Array<{ path: string; state: 'present' | 'absent' }>
  /** Steps that were still `open` and got closed as `aborted` by this run. */
  closedCheckpoints: string[]
  task: Task
  checkpoints: TaskCheckpoint[]
}

export function rollbackTask(input: RollbackInput): RollbackResult {
  const task = input.store.getTask(input.taskId)
  if (task === null) throw new TaskError('invalid-task', `task ${input.taskId} not found`)

  const target = input.checkpointId
  if (target !== undefined) {
    const checkpoint = input.store.getCheckpoint(target)
    if (checkpoint === null) throw new TaskError('not-found', `checkpoint ${target} not found`)
    if (checkpoint.taskId !== task.id) {
      throw new TaskError('invalid-input', `checkpoint ${target} belongs to ${checkpoint.taskId}`)
    }
  }

  let restored: RollbackResult['restored']
  try {
    restored = input.port.rollback({
      taskId: task.id,
      ...target === undefined ? {} : { checkpointId: target },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TaskError('rollback-failed', `rollback failed: ${message}`)
  }

  const closed: string[] = []
  for (const checkpoint of input.store.listCheckpoints(task.id)) {
    if (checkpoint.status !== 'open') continue
    if (target !== undefined && checkpoint.id !== target) continue
    input.store.closeCheckpoint(checkpoint.id, 'aborted')
    closed.push(checkpoint.id)
  }

  input.store.appendEvent(task.id, 'task.rollback', {
    scope: target === undefined ? 'task' : 'checkpoint',
    checkpointId: target ?? null,
    restored: restored.length,
    closedCheckpoints: closed,
    ...input.reason === undefined ? {} : { reason: input.reason },
  })

  return {
    taskId: task.id,
    checkpointId: target ?? null,
    restored,
    closedCheckpoints: closed,
    task: input.store.getTask(task.id) as Task,
    checkpoints: input.store.listCheckpoints(task.id),
  }
}
