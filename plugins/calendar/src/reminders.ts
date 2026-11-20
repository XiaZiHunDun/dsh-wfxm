/**
 * 会前提醒（Slice BQ）：定时扫描本机日程，把即将开始的事件推给 owner。
 *
 * 复用现有出站通道（`topic: 'say'` + `dedupeKey`），不新建通知设施。
 * 去重有两层：
 *   1. 库字段 `reminded_at`：成功入队后标记，进程重启不会重发；
 *   2. outbox `dedupeKey=calendar-reminder:<eventId>`：极端情况下也压成一条。
 *
 * 没有 live owner binding 时不标记，下一轮再试（不静默丢弃提醒）。
 */

import { formatShanghai } from './time.js'
import type { CalendarStore, StoredCalendarEvent } from './store.js'

export const DEFAULT_REMINDER_LEAD_MINUTES = 10
export const DEFAULT_REMINDER_INTERVAL_MS = 60_000

export interface CalendarReminderBinding {
  externalUserId: string
}

export interface CalendarReminderGateway {
  listBindings(): CalendarReminderBinding[]
  enqueueOutbox(input: {
    topic: 'say'
    payload: { text: string; openId: string }
    dedupeKey: string
  }): { id: string }
}

export interface CalendarReminderLogger {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface CalendarReminderPatrolOptions {
  store: CalendarStore
  gateway: CalendarReminderGateway
  /** 提前多少分钟提醒；<=0 表示关闭。 */
  leadMinutes?: number
  intervalMs?: number
  now?: () => Date
  logger?: CalendarReminderLogger
}

export interface CalendarReminderPatrol {
  /** 立即扫描一轮，返回成功入队条数。 */
  runOnce(): number
  start(): void
  stop(): void
}

/** 「提醒：还有 10 分钟开始「周会」（09:00 开始，地点：会议室 A）」 */
export function formatCalendarReminder(event: StoredCalendarEvent, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((event.startMs - nowMs) / 60_000))
  const title = event.summary === '' ? '（无标题）' : event.summary
  const at = formatShanghai(new Date(event.startMs)).slice(11)
  const location = event.location === '' ? '' : `，地点：${event.location}`
  return `提醒：还有 ${minutes} 分钟开始「${title}」（${at} 开始${location}）`
}

export function createCalendarReminderPatrol(
  options: CalendarReminderPatrolOptions,
): CalendarReminderPatrol {
  const leadMinutes = Number.isFinite(options.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES)
    ? (options.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES)
    : DEFAULT_REMINDER_LEAD_MINUTES
  const intervalMs = Number.isFinite(options.intervalMs ?? DEFAULT_REMINDER_INTERVAL_MS)
    && (options.intervalMs ?? DEFAULT_REMINDER_INTERVAL_MS) > 0
    ? (options.intervalMs ?? DEFAULT_REMINDER_INTERVAL_MS)
    : DEFAULT_REMINDER_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const logger = options.logger
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  function runOnce(): number {
    if (leadMinutes <= 0) return 0
    const at = now()
    const events = options.store.listStartingSoon({
      nowMs: at.getTime(),
      leadMs: leadMinutes * 60_000,
    })
    if (events.length === 0) return 0

    const openId = options.gateway.listBindings().at(-1)?.externalUserId
    if (openId === undefined || openId === '') {
      logger?.warn?.('calendar reminder skipped: no live owner binding')
      return 0
    }

    const stamp = at.toISOString()
    let sent = 0
    for (const event of events) {
      try {
        const item = options.gateway.enqueueOutbox({
          topic: 'say',
          payload: { text: formatCalendarReminder(event, at.getTime()), openId },
          dedupeKey: `calendar-reminder:${event.eventId}`,
        })
        options.store.markReminded(event.eventId, stamp)
        sent += 1
        logger?.info?.(`calendar reminder queued: ${event.eventId} (outbox=${item.id})`)
      } catch (error) {
        logger?.warn?.(
          `calendar reminder failed for ${event.eventId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return sent
  }

  return {
    runOnce() {
      if (running) return 0
      running = true
      try {
        return runOnce()
      } catch (error) {
        logger?.warn?.(`calendar reminder scan failed: ${error instanceof Error ? error.message : String(error)}`)
        return 0
      } finally {
        running = false
      }
    },

    start() {
      if (timer !== null) return
      this.runOnce()
      timer = setInterval(() => {
        this.runOnce()
      }, intervalMs)
      timer.unref?.()
    },

    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
  }
}
