/**
 * 上海墙钟时间的小工具（J4）。
 *
 * 存储与接口一律用带偏移的 ISO8601；只在展示与"今天/窗口"计算时换算，
 * 且不依赖运行主机的时区（生产机可能是 UTC）。
 */

export const CALENDAR_TIME_ZONE = 'Asia/Shanghai'

/** 上海没有夏令时，固定 +08:00。 */
const SHANGHAI_OFFSET = '+08:00'

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CALENDAR_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CALENDAR_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `2026-11-20`（上海）。 */
export function todayInShanghai(now: Date = new Date()): string {
  return DATE_FORMAT.format(now)
}

/** `YYYY-MM-DD` → 该日 00:00（上海）的 epoch 毫秒。 */
export function shanghaiMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00${SHANGHAI_OFFSET}`)
}

/** `2026-11-20 09:00`（上海）。 */
export function formatShanghai(when: Date): string {
  const parts = DATE_TIME_FORMAT.formatToParts(when)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}
