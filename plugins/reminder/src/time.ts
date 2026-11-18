/**
 * 提醒的时间计算与展示（J5）。
 *
 * 存储统一用 UTC ISO；展示统一按 `Asia/Shanghai`。周期推进用固定毫秒
 * （北京无夏令时），停机期间错过多次只跳到**第一个未来时刻**，不补发一串。
 */

export const REMINDER_TIME_ZONE = 'Asia/Shanghai'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** 支持的一次性/周期类型；不做 cron。 */
export type ReminderRepeat = 'none' | 'daily' | 'weekly'

const REPEATS: readonly ReminderRepeat[] = ['none', 'daily', 'weekly']

export function isReminderRepeat(value: unknown): value is ReminderRepeat {
  return typeof value === 'string' && (REPEATS as readonly string[]).includes(value)
}

/**
 * 下一次触发时间；一次性返回 `null`。
 * `now` 已过多个周期时只返回第一个 `> now` 的时刻（不补发）。
 */
export function nextDueAt(
  dueAt: string,
  repeat: ReminderRepeat,
  now: Date,
): string | null {
  if (repeat === 'none') return null
  const start = Date.parse(dueAt)
  if (Number.isNaN(start)) return null
  const step = repeat === 'daily' ? DAY_MS : WEEK_MS
  // 正常触发时 start <= now；时钟回拨时也至少前进一个周期，避免原地打转。
  const steps = Math.max(1, Math.floor((now.getTime() - start) / step) + 1)
  return new Date(start + steps * step).toISOString()
}

/** 上海墙钟的年月日与时分（`hourCycle: h23` 避免午夜出现 24 点）。 */
function shanghaiParts(when: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(when)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  }
}

/**
 * 展示用时间：今天 / 明天 / 同年 `MM-DD HH:mm` / 跨年 `YYYY-MM-DD HH:mm`。
 * 解析失败时原样返回，避免把坏数据展示成 `Invalid Date`。
 */
export function formatReminderDue(dueAt: string, now: Date): string {
  const target = new Date(dueAt)
  if (Number.isNaN(target.getTime())) return dueAt
  const due = shanghaiParts(target)
  const today = shanghaiParts(now)
  const tomorrow = shanghaiParts(new Date(now.getTime() + DAY_MS))
  if (due.date === today.date) return `今天 ${due.time}`
  if (due.date === tomorrow.date) return `明天 ${due.time}`
  if (due.date.slice(0, 4) === today.date.slice(0, 4)) return `${due.date.slice(5)} ${due.time}`
  return `${due.date} ${due.time}`
}

/** `（每天）` / `（每周）` 之类的后缀；一次性为空串。 */
export function repeatSuffix(repeat: ReminderRepeat): string {
  if (repeat === 'daily') return '（每天）'
  if (repeat === 'weekly') return '（每周）'
  return ''
}
