/**
 * Validation of the front-desk decision (docs/17 §7.3: S2's output is a
 * structured `choice + reason`, and it may only tighten what the rules allow).
 *
 * Everything the model returns is untrusted text: unknown actions, oversized
 * bodies and inflated risk levels are rejected here instead of reaching ⑤. A
 * rejected decision is never guessed into an action — the caller degrades to the
 * deterministic rule foreground (loudly, see `foreground.ts`).
 */

export type DecisionRisk = 'R0' | 'R1'

/** 提醒的重复类型（与 `@dsh-wfxm/reminder` 一致，但本包不 import 它）。 */
export type DecisionRepeat = 'none' | 'daily' | 'weekly'

export type Decision =
  | { action: 'reply'; text: string }
  | { action: 'task'; intent: string; risk: DecisionRisk }
  | { action: 'queue'; text: string }
  | { action: 'remind'; at: string; text: string; repeat: DecisionRepeat }
  | { action: 'reminders' }
  | { action: 'cancel_remind'; index: number }
  | { action: 'mail_todos'; hours: number }
  | { action: 'calendar_view'; days: number }

export type DecisionParse =
  | { ok: true; decision: Decision }
  | { ok: false; reason: string }

export interface ParseDecisionOptions {
  /** True when this thread has a live task a `queue` decision could target. */
  liveTask?: boolean
  /** Replies longer than this are rejected (channel split is 4000). */
  maxReplyChars?: number
  /** Intents longer than this are rejected. */
  maxIntentChars?: number
  /** 当前时间；`remind.at` 必须晚于它（缺省取系统时间）。 */
  now?: Date
  /** 前台是否挂了提醒端口；未挂时三种提醒动作一律视为未知。 */
  remindersEnabled?: boolean
  /** 前台是否挂了邮件待办端口；未挂时 `mail_todos` 视为未知。 */
  todosEnabled?: boolean
  /** 前台是否挂了日历读取端口；未挂时 `calendar_view` 视为未知。 */
  calendarEnabled?: boolean
}

export const DEFAULT_MAX_REPLY_CHARS = 4_000
/** ⑤ caps a task intent at 500 characters; validate here so it degrades early. */
export const DEFAULT_MAX_INTENT_CHARS = 500
/** 提醒语最多 200 字：它只是通知，不是任务描述。 */
export const DEFAULT_MAX_REMINDER_CHARS = 200
/** 提醒最远一年：超出多半是模型算错时间。 */
export const MAX_REMINDER_AHEAD_MS = 366 * 86_400_000
/** 列表最多展示 20 条，序号也以此为上限。 */
export const MAX_REMINDER_INDEX = 20
/** 邮件待办默认回看 48 小时；最多一周。 */
export const DEFAULT_TODO_HOURS = 48
export const MAX_TODO_HOURS = 168
/** 日程查看窗口：今天=1，本周=7，最多 31 天。 */
export const DEFAULT_CALENDAR_DAYS = 7
export const MAX_CALENDAR_DAYS = 31

/** Strip fences / prose and return the outermost JSON object, or null. */
export function extractJsonObject(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced === null ? text : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return body.slice(start, end + 1)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function parseDecision(raw: string, options: ParseDecisionOptions = {}): DecisionParse {
  const maxReply = options.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS
  const maxIntent = options.maxIntentChars ?? DEFAULT_MAX_INTENT_CHARS

  const json = extractJsonObject(raw)
  if (json === null) return { ok: false, reason: 'not-json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  const record = asRecord(parsed)
  if (record === null) return { ok: false, reason: 'not-an-object' }

  const action = nonEmpty(record.action)
  if (action === null) return { ok: false, reason: 'missing-action' }

  if (action === 'reply') {
    const text = nonEmpty(record.text)
    if (text === null) return { ok: false, reason: 'reply-empty' }
    if (text.length > maxReply) return { ok: false, reason: 'reply-too-long' }
    return { ok: true, decision: { action: 'reply', text } }
  }

  if (action === 'task') {
    const intent = nonEmpty(record.intent)
    if (intent === null) return { ok: false, reason: 'intent-empty' }
    if (intent.length > maxIntent) return { ok: false, reason: 'intent-too-long' }

    const rawRisk = record.risk
    if (rawRisk === undefined || rawRisk === null || rawRisk === '') {
      return { ok: true, decision: { action: 'task', intent, risk: 'R1' } }
    }
    if (typeof rawRisk !== 'string') return { ok: false, reason: 'invalid-risk' }
    const risk = rawRisk.trim().toUpperCase()
    if (risk === 'R0' || risk === 'R1') {
      return { ok: true, decision: { action: 'task', intent, risk } }
    }
    // §8.7: R2+ needs assertions from the template library; the front desk has
    // none, so it is not allowed to raise the level. Reject rather than lower it.
    if (risk === 'R2' || risk === 'R3') return { ok: false, reason: 'risk-not-allowed' }
    return { ok: false, reason: 'invalid-risk' }
  }

  if (action === 'queue') {
    const text = nonEmpty(record.text)
    if (text === null) return { ok: false, reason: 'queue-empty' }
    if (text.length > maxIntent) return { ok: false, reason: 'queue-too-long' }
    if (options.liveTask !== true) return { ok: false, reason: 'queue-without-task' }
    return { ok: true, decision: { action: 'queue', text } }
  }

  // 提醒动作只在端口注入时才存在：没有能力就不让模型"决定"一个做不到的动作。
  if (action === 'remind' || action === 'reminders' || action === 'cancel_remind') {
    if (options.remindersEnabled !== true) return { ok: false, reason: 'reminders-unavailable' }
  }

  if (action === 'remind') {
    const at = nonEmpty(record.at)
    if (at === null) return { ok: false, reason: 'remind-at-missing' }
    const due = Date.parse(at)
    if (Number.isNaN(due)) return { ok: false, reason: 'remind-at-invalid' }
    const now = options.now ?? new Date()
    if (due <= now.getTime()) return { ok: false, reason: 'remind-at-past' }
    if (due - now.getTime() > MAX_REMINDER_AHEAD_MS) return { ok: false, reason: 'remind-at-too-far' }

    const text = nonEmpty(record.text)
    if (text === null) return { ok: false, reason: 'remind-text-empty' }
    if (text.length > DEFAULT_MAX_REMINDER_CHARS) return { ok: false, reason: 'remind-text-too-long' }

    const rawRepeat = record.repeat
    let repeat: DecisionRepeat = 'none'
    if (rawRepeat !== undefined && rawRepeat !== null && rawRepeat !== '') {
      if (typeof rawRepeat !== 'string') return { ok: false, reason: 'invalid-repeat' }
      const value = rawRepeat.trim().toLowerCase()
      if (value !== 'none' && value !== 'daily' && value !== 'weekly') {
        return { ok: false, reason: 'invalid-repeat' }
      }
      repeat = value
    }
    // 归一化为 UTC ISO：存储与展示分开，模型给的 +08:00 不进入数据。
    return { ok: true, decision: { action: 'remind', at: new Date(due).toISOString(), text, repeat } }
  }

  if (action === 'reminders') {
    return { ok: true, decision: { action: 'reminders' } }
  }

  if (action === 'cancel_remind') {
    const raw = record.index
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_REMINDER_INDEX) {
      return { ok: false, reason: 'invalid-reminder-index' }
    }
    return { ok: true, decision: { action: 'cancel_remind', index: raw } }
  }

  // 邮件待办同理：没有取数/提取能力就不允许模型"决定"这个动作。
  if (action === 'mail_todos') {
    if (options.todosEnabled !== true) return { ok: false, reason: 'todos-unavailable' }
    const raw = record.hours
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, decision: { action: 'mail_todos', hours: DEFAULT_TODO_HOURS } }
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TODO_HOURS) {
      return { ok: false, reason: 'invalid-todo-hours' }
    }
    return { ok: true, decision: { action: 'mail_todos', hours: raw } }
  }

  // 日历读取同理：端口缺失时不允许模型"决定"一个做不到的动作。
  if (action === 'calendar_view') {
    if (options.calendarEnabled !== true) return { ok: false, reason: 'calendar-unavailable' }
    const raw = record.days
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, decision: { action: 'calendar_view', days: DEFAULT_CALENDAR_DAYS } }
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_CALENDAR_DAYS) {
      return { ok: false, reason: 'invalid-calendar-days' }
    }
    return { ok: true, decision: { action: 'calendar_view', days: raw } }
  }

  return { ok: false, reason: 'unknown-action' }
}
