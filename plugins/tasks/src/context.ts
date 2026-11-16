/**
 * Ambient task context (13 §3.4 步级回滚).
 *
 * The worker runs the injected executor inside `runWithTaskContext`, so every
 * tool call issued while a task executes is attributable to that task. ④ reads
 * the id through a host-injected resolver (`setTaskContextResolver` in
 * `@dsh-wfxm/governance`) and stamps `file_preimages.task_id`.
 *
 * Parallel tasks in one process stay isolated: `AsyncLocalStorage` keeps one
 * store per execution chain. Outside any task it is simply `null`, so the same
 * gate keeps working for chat-driven tool calls.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface TaskContext {
  taskId: string
  projectId: string | null
  /** 1-based attempt of this run; a retry starts a fresh context. */
  attempt: number
  /** Open step boundary (`beginCheckpoint`), or null outside a step. */
  checkpointId: string | null
}

const storage = new AsyncLocalStorage<TaskContext>()

export function runWithTaskContext<T>(context: TaskContext, fn: () => T): T {
  return storage.run(context, fn)
}

/**
 * Nests the current task context with one open step. Writes made inside `fn`
 * are stamped with `checkpointId`, so a failed step can be rolled back alone.
 * Outside a task there is nothing to nest into: `fn` still runs (the tool gate
 * simply keeps `checkpoint_id` NULL) — attribution must never block work.
 */
export function runWithCheckpoint<T>(checkpointId: string, fn: () => T): T {
  const current = storage.getStore()
  if (current === undefined) return fn()
  return storage.run({ ...current, checkpointId }, fn)
}

export function currentTaskContext(): TaskContext | null {
  return storage.getStore() ?? null
}

export function currentTaskId(): string | null {
  return storage.getStore()?.taskId ?? null
}

export function currentCheckpointId(): string | null {
  return storage.getStore()?.checkpointId ?? null
}
