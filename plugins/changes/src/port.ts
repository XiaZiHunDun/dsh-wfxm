/**
 * ⑤ 的 `ChangePort`（结构契约，AR32）：任务只报「我改了什么、到哪一步」，
 * 台账由 ⑦ 的 `changes` 独占写入（AR33）。⑤ 不 import 本包。
 */

import type { ChangeKind, ChangeStore } from './store.js'

export interface TaskChangeBeginInput {
  taskId: string
  kind?: ChangeKind
  target?: string
  snapshotId?: string | null
}

export interface TaskChangePort {
  begin(input: TaskChangeBeginInput): { ok: boolean; code?: string }
  keep(input: { taskId: string; detail?: string }): { ok: boolean; code?: string }
  markFailed(input: { taskId: string; detail?: string }): { ok: boolean; code?: string }
}

/** 把 store 的 `ChangeResult` 收窄成 ⑤ 只关心的是否成功。 */
function ack(result: { ok: true } | { ok: false; code: string }): { ok: boolean; code?: string } {
  return result.ok ? { ok: true } : { ok: false, code: result.code }
}

export function createTaskChangePort(store: ChangeStore): TaskChangePort {
  return {
    begin(input) {
      return ack(store.begin({
        taskId: input.taskId,
        ...input.kind === undefined ? {} : { kind: input.kind },
        ...input.target === undefined ? {} : { target: input.target },
        ...input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId },
      }))
    },
    keep(input) {
      return ack(store.keep(input.taskId, input.detail ?? null))
    },
    markFailed(input) {
      return ack(store.markFailed(input.taskId, input.detail ?? null))
    },
  }
}
