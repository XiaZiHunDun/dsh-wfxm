/**
 * 前台/宿主共用的提醒视图与端口（J5）。
 *
 * 视图里的 `when` / `repeatLabel` 是**展示用**、按 `Asia/Shanghai` 预格式化，
 * 这样决策包与确认文案都不需要再做时区计算。
 */

import type { Reminder, ReminderStore } from './store.js'
import {
  formatReminderDue,
  repeatSuffix,
  type ReminderRepeat,
} from './time.js'

export interface ReminderView {
  id: string
  text: string
  dueAt: string
  repeat: ReminderRepeat
  /** 展示用时间，例如「明天 09:00」。 */
  when: string
  /** 「（每天）」/「（每周）」；一次性为空串。 */
  repeatLabel: string
}

export interface ReminderPort {
  create(input: {
    threadId: string
    text: string
    dueAt: string
    repeat: ReminderRepeat
    sourceMsgId: string | null
  }): ReminderView
  listPending(threadId: string, limit?: number): ReminderView[]
  cancel(id: string): ReminderView | null
}

export function toReminderView(item: Reminder, now: Date): ReminderView {
  return {
    id: item.id,
    text: item.text,
    dueAt: item.dueAt,
    repeat: item.repeat,
    when: formatReminderDue(item.dueAt, now),
    repeatLabel: repeatSuffix(item.repeat),
  }
}

/** 把 store 适配成前台端口；`clock` 可注入，展示时间随调用时刻刷新。 */
export function createReminderPort(
  store: ReminderStore,
  clock: () => Date = () => new Date(),
): ReminderPort {
  return {
    create(input) {
      const item = store.create(input)
      return toReminderView(item, clock())
    },
    listPending(threadId, limit) {
      const at = clock()
      return store.listPending(threadId, limit).map((item) => toReminderView(item, at))
    },
    cancel(id) {
      const item = store.cancel(id)
      return item === null ? null : toReminderView(item, clock())
    },
  }
}
