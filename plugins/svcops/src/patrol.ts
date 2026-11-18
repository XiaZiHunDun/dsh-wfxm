/**
 * G2 + G3 scheduled slice: run the minimal inspection on a timer, push
 * `fail` findings immediately and one digest per day (docs/08 决策 #6/#7).
 *
 * The scheduler owns the timer and the `inspections` store; delivery is a
 * callback so module ⑥ (outbox) stays the only place that knows about Feishu.
 * Pure helpers are exported for the renderer/tests.
 */

import { hostname } from 'node:os'
import { gradeInspection, type AlertDecision } from './inspection/alerting.js'
import { deriveCandidates } from './inspection/candidates.js'
import {
  DEFAULT_THRESHOLDS,
  evaluate,
  type InspectionReport,
  type InspectionThresholds,
} from './inspection/checklist.js'
import { collectHostMetrics } from './inspection/probes.js'
import { formatCandidateDigest, summarize, type InspectionDigest } from './inspection/report.js'
import { createInspectionStore, type InspectionRecord } from './inspection/store.js'
import { spawnRunner } from './systemd.js'

/** Defaults are deliberately boring: a quiet host says nothing until 09:00. */
export const DEFAULT_PATROL_INTERVAL_MINUTES = 15
export const DEFAULT_DIGEST_HOUR = 9
export const DEFAULT_DIGEST_WINDOW_HOURS = 24
export const DEFAULT_ALERT_QUIET_MS = 30 * 60_000
/** Monday. -1 disables the weekly report without touching the daily digests. */
export const DEFAULT_WEEKLY_DIGEST_DAY = 1
export const WEEKLY_WINDOW_HOURS = 168

export interface PatrolConfig {
  /** 0 disables the timer entirely. */
  intervalMinutes: number
  /** -1 disables the daily digest; otherwise 0-23 in the host's local time. */
  digestHour: number
  /** -1 disables the weekly report; 0=Sunday … 6=Saturday in local time. */
  weeklyDay: number
  /** Recorded in `inspections.target`; defaults to `hostname()`. */
  target: string
}

export interface PatrolConfigResult {
  config: PatrolConfig
  warnings: string[]
}

function parseInteger(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
  fallback: number,
  warnings: string[],
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    warnings.push(`${field}=${JSON.stringify(raw)} is not an integer in ${min}-${max}; using ${fallback}`)
    return fallback
  }
  return value
}

/**
 * `DSH_WFXM_PATROL_INTERVAL_MINUTES=0` is the only way to disable patrol;
 * invalid values keep the default so a typo never turns monitoring off.
 */
export function readPatrolConfig(
  env: NodeJS.ProcessEnv = process.env,
  fallbackTarget: string = hostname(),
): PatrolConfigResult {
  const warnings: string[] = []
  const intervalMinutes = parseInteger(
    env.DSH_WFXM_PATROL_INTERVAL_MINUTES,
    'DSH_WFXM_PATROL_INTERVAL_MINUTES',
    0,
    1440,
    DEFAULT_PATROL_INTERVAL_MINUTES,
    warnings,
  )
  const digestHour = parseInteger(
    env.DSH_WFXM_DIGEST_HOUR,
    'DSH_WFXM_DIGEST_HOUR',
    -1,
    23,
    DEFAULT_DIGEST_HOUR,
    warnings,
  )
  const weeklyDay = parseInteger(
    env.DSH_WFXM_WEEKLY_DIGEST_DAY,
    'DSH_WFXM_WEEKLY_DIGEST_DAY',
    -1,
    6,
    DEFAULT_WEEKLY_DIGEST_DAY,
    warnings,
  )
  const target = env.DSH_WFXM_PATROL_TARGET?.trim()
  return {
    config: {
      intervalMinutes,
      digestHour,
      weeklyDay,
      target: target === undefined || target === '' ? fallbackTarget : target,
    },
    warnings,
  }
}

export interface AlertTextInput {
  target: string
  checklistId: string
  status: string
  ranAt: string
  reasons: string[]
}

export function formatInspectionAlert(input: AlertTextInput): string {
  return [
    `[巡检告警] ${input.target} · ${input.status}`,
    `清单 ${input.checklistId} · ${input.ranAt}`,
    ...input.reasons.map((reason) => `- ${reason}`),
    '已记录为候选（observe，不自动建任务）。',
    '回复「巡检」可查看最近一次报告。',
  ].join('\n')
}

export function formatInspectionDigest(digest: InspectionDigest, target: string): string {
  const head = `[巡检日报] ${target} · 近 ${digest.hours}h`
  if (digest.runs === 0 || digest.latest === null) return `${head}\n窗口内没有巡检记录。`
  const lines = [
    head,
    `巡检 ${digest.runs} 次：正常 ${digest.byStatus.ok} / 警告 ${digest.byStatus.warn} / 失败 ${digest.byStatus.fail} / 跳过 ${digest.byStatus.skipped}`,
    `告警：静默 ${digest.byAlert.silent} / 摘要 ${digest.byAlert.digest} / 即时 ${digest.byAlert.immediate}`,
    `最新：${digest.latest.ranAt} ${digest.latest.target} ${digest.latest.status}（${digest.latest.level}）`,
  ]
  if (digest.findings.length > 0) {
    lines.push('持续项：', ...digest.findings.map((finding) => `- ${finding}`))
  }
  return lines.join('\n')
}

/** One line (plus optional findings) for the weekly report; the daily layout stays unchanged. */
export function formatInspectionWeek(digest: InspectionDigest): string {
  if (digest.runs === 0 || digest.latest === null) return '巡检：近 7 天没有记录。'
  const lines = [
    `巡检 ${digest.runs} 次：正常 ${digest.byStatus.ok} / 警告 ${digest.byStatus.warn} / 失败 ${digest.byStatus.fail} / 跳过 ${digest.byStatus.skipped}`,
  ]
  if (digest.findings.length > 0) {
    lines.push(`持续项：${digest.findings.slice(0, 3).join('；')}`)
  }
  return lines.join('\n')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function monthDay(at: Date): string {
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/**
 * ISO week key in the host's local calendar (`YYYY-Www`). Used only for the
 * weekly dedupe key, so a restart cannot re-push the same ISO week.
 */
export function isoWeekKey(at: Date): string {
  const date = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()))
  const day = date.getUTCDay() || 7
  // Thursday of this week decides both the ISO year and the week number.
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const year = date.getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  const week = Math.ceil(((date.getTime() - start) / 86_400_000 + 1) / 7)
  return `${year}-W${pad2(week)}`
}

export interface PatrolDelivery {
  text: string
  /** Passed to the outbox so a retry/restart cannot push twice. */
  dedupeKey: string
}

export interface InspectionPatrolOptions {
  dbPath: string
  config: PatrolConfig
  thresholds?: InspectionThresholds
  expectedPorts?: number[]
  /** Module ⑥ seam: enqueue the text; must not throw for a delivery failure. */
  deliver: (delivery: PatrolDelivery) => void
  now?: () => Date
  /** Test seam; defaults to the real probes + `evaluate`. */
  collect?: (now: Date) => Promise<InspectionReport>
  alertQuietMs?: number
  initialDelayMs?: number
  /**
   * Optional task digest (Slice M). Called once per day at digest time; when it
   * returns text a second push goes out under its own dedupe key. The scheduler
   * stays here, while task data is read by the composition root (no table access).
   */
  taskDigest?: (window: { from: Date; to: Date }) => string | null
  /**
   * Optional conversation digest (Slice N/O). Same daily gate and window as the
   * task digest, but its own message and dedupe key; returns `null` when no
   * conversation was active so quiet days stay quiet. May be async because the
   * semantic summary (Slice O) is one bounded model turn; rejection is isolated
   * exactly like a throw.
   */
  conversationDigest?: (window: { from: Date; to: Date }) => string | null | Promise<string | null>
  /**
   * Optional weekly sections (Slice P): task + conversation text for the last
   * 7 days, rendered by their owners in the composition root. The patrol adds
   * its own inspection section and the `[周报]` header; a throw here leaves the
   * inspection section intact. Only called once on the configured weekday.
   */
  weeklySections?: (window: { from: Date; to: Date }) => string | null | Promise<string | null>
  /**
   * Outbound health line (Slice Q): one line appended to the daily digest and
   * the weekly report ("出站：失败 N · 积压 M"). ① owns the numbers, the
   * composition root formats them; a throw leaves the digest intact.
   */
  outboxDigest?: (window: { from: Date; to: Date }) => string | null
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
}

export interface PatrolRunResult {
  record: InspectionRecord
  alert: AlertDecision
  /** `alert`, `digest`, `tasks`, `conversations`, `weekly`, or their `+` combinations; `null` when nothing was pushed. */
  pushed: string | null
}

export interface InspectionPatrol {
  /** Starts the timer; the first run happens after `initialDelayMs`. */
  start(): void
  stop(): void
  /** One deterministic cycle, also used by the verification script. */
  runOnce(): Promise<PatrolRunResult>
}

function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function createInspectionPatrol(options: InspectionPatrolOptions): InspectionPatrol {
  const store = createInspectionStore(options.dbPath)
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS
  const expectedPorts = options.expectedPorts ?? []
  const target = options.config.target
  const now = options.now ?? (() => new Date())
  const quietMs = options.alertQuietMs ?? DEFAULT_ALERT_QUIET_MS
  const collect = options.collect ?? (async (at: Date) => evaluate(
    await collectHostMetrics({
      runner: spawnRunner,
      expectedPorts,
      logWindowMinutes: thresholds.logWindowMinutes,
    }),
    thresholds,
    expectedPorts,
  ))

  const lastAlertAt = new Map<string, number>()
  let lastDigestDay: string | null = null
  let lastWeeklyAttempt: string | null = null
  let running = false
  let initialTimer: NodeJS.Timeout | null = null
  let intervalTimer: NodeJS.Timeout | null = null
  let closed = false

  const push = (delivery: PatrolDelivery): void => {
    try {
      options.deliver(delivery)
    } catch (error) {
      // Delivery sits outside the inspection: a transport failure is logged,
      // never allowed to take the service down or fail the run.
      options.logger?.warn?.(`push failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Slice Q: the line is optional and isolated exactly like the other digests.
  const readOutboxLine = (from: Date, to: Date): string | null => {
    try {
      return options.outboxDigest?.({ from, to }) || null
    } catch (error) {
      options.logger?.warn?.(
        `outbox digest failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  const runOnce = async (): Promise<PatrolRunResult> => {
    const at = now()
    const report = await collect(at)
    const record = store.save({
      checklistId: report.checklistId,
      target,
      status: report.status,
      items: report.items,
      ranAt: at.toISOString(),
    })
    // B2 v1: observe-only candidates are recorded on every cycle, including
    // cycles whose alert is suppressed by the quiet window.
    const candidates = deriveCandidates(report, target)
    store.recordCandidates(candidates, at)
    store.resolveCandidates(candidates, target, at)
    const alert = gradeInspection(report)
    let pushed: string | null = null

    if (alert.level === 'immediate') {
      const failedIds = report.items
        .filter((item) => item.status === 'fail')
        .map((item) => item.id)
        .sort()
        .join(',')
      const key = `patrol-alert:${target}:${failedIds}`
      const last = lastAlertAt.get(key) ?? 0
      if (at.getTime() - last < quietMs) {
        options.logger?.info?.(`alert suppressed by the ${Math.round(quietMs / 60_000)}min quiet window: ${failedIds}`)
      } else {
        push({
          text: formatInspectionAlert({
            target,
            checklistId: record.checklistId,
            status: record.status,
            ranAt: record.ranAt,
            reasons: alert.reasons,
          }),
          // Bucket by the quiet window so a restart cannot re-push the same
          // failure inside it, while a reminder after it still gets a new key.
          dedupeKey: `${key}:${Math.floor(at.getTime() / quietMs)}`,
        })
        lastAlertAt.set(key, at.getTime())
        pushed = 'alert'
      }
    }

    if (options.config.digestHour >= 0 && at.getHours() >= options.config.digestHour) {
      const day = localDate(at)
      const week = isoWeekKey(at)
      const weeklyDayToday = options.config.weeklyDay >= 0 && at.getDay() === options.config.weeklyDay
      let weeklySent = false

      // Weekly report (Slice P): same gate, one extra branch. Its 7-day window
      // is a superset of the daily 24h one, so a successful weekly message
      // replaces the three daily ones for that day; an empty/failed weekly
      // falls through to the normal daily block (a Monday is never silent).
      if (weeklyDayToday && lastWeeklyAttempt !== week) {
        lastWeeklyAttempt = week
        const from = new Date(at.getTime() - WEEKLY_WINDOW_HOURS * 3_600_000)
        const digest = summarize(store.listSince(from.toISOString(), at.toISOString()), {
          hours: WEEKLY_WINDOW_HOURS,
          now: at,
        })
        let sections: string | null = null
        try {
          sections = (await options.weeklySections?.({ from, to: at })) ?? null
        } catch (error) {
          options.logger?.warn?.(
            `weekly sections failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const outbox = readOutboxLine(from, at)
        if (digest.runs > 0 || (sections !== null && sections !== '')) {
          const text = [
            `[周报] ${target} · ${monthDay(from)} ~ ${monthDay(at)}`,
            formatInspectionWeek(digest),
            sections ?? '',
            outbox ?? '',
          ].filter((line) => line !== '').join('\n')
          push({ text, dedupeKey: `weekly-digest:${week}` })
          pushed = pushed === null ? 'weekly' : `${pushed}+weekly`
          weeklySent = true
          lastDigestDay = day
        }
      }

      if (!weeklySent && lastDigestDay !== day) {
        const from = new Date(at.getTime() - DEFAULT_DIGEST_WINDOW_HOURS * 3_600_000)
        const digest = summarize(store.listSince(from.toISOString(), at.toISOString()), {
          hours: DEFAULT_DIGEST_WINDOW_HOURS,
          now: at,
        })
        if (digest.runs > 0) {
          const candidateSection = formatCandidateDigest(store.candidateDigest(from.toISOString()))
          push({
            text: [
              formatInspectionDigest(digest, target),
              candidateSection ?? '',
              readOutboxLine(from, at) ?? '',
            ]
              .filter((line) => line !== '')
              .join('\n'),
            dedupeKey: `patrol-digest:${target}:${day}`,
          })
          pushed = pushed === null ? 'digest' : `${pushed}+digest`
        }
        // Task digest (Slice M): its own message and key, so a quiet inspection
        // day never swallows "what did you do yesterday".
        let tasks: string | null = null
        try {
          tasks = options.taskDigest?.({ from, to: at }) ?? null
        } catch (error) {
          options.logger?.warn?.(`task digest failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (tasks !== null && tasks !== '') {
          push({ text: tasks, dedupeKey: `task-digest:${day}` })
          pushed = pushed === null ? 'tasks' : `${pushed}+tasks`
        }
        // Conversation digest (Slice N/O): independent message + key, so neither
        // the inspection nor the task digest can swallow it. Awaited because the
        // semantic layer may call the model; its rejection is caught here.
        let conversations: string | null = null
        try {
          conversations = (await options.conversationDigest?.({ from, to: at })) ?? null
        } catch (error) {
          options.logger?.warn?.(
            `conversation digest failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (conversations !== null && conversations !== '') {
          push({ text: conversations, dedupeKey: `conversation-digest:${day}` })
          pushed = pushed === null ? 'conversations' : `${pushed}+conversations`
        }
        lastDigestDay = day
      }
    }

    return { record, alert, pushed }
  }

  const tick = async (): Promise<void> => {
    if (running) {
      options.logger?.warn?.('previous cycle still running; tick skipped')
      return
    }
    running = true
    try {
      const result = await runOnce()
      options.logger?.info?.(`cycle ${result.record.status}${result.pushed === null ? '' : ` (pushed ${result.pushed})`}`)
    } catch (error) {
      // One bad probe cycle must not kill the timer.
      options.logger?.warn?.(`cycle failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (closed) throw new Error('patrol already stopped')
      if (options.config.intervalMinutes <= 0) {
        options.logger?.info?.('disabled (DSH_WFXM_PATROL_INTERVAL_MINUTES=0)')
        return
      }
      if (initialTimer !== null || intervalTimer !== null) return
      const intervalMs = options.config.intervalMinutes * 60_000
      const initialDelayMs = options.initialDelayMs ?? 15_000
      initialTimer = setTimeout(() => {
        initialTimer = null
        void tick()
      }, initialDelayMs)
      initialTimer.unref()
      intervalTimer = setInterval(() => void tick(), intervalMs)
      intervalTimer.unref()
      options.logger?.info?.(`every ${options.config.intervalMinutes}min, digest ${options.config.digestHour < 0 ? 'off' : `${options.config.digestHour}:00`}, weekly ${options.config.weeklyDay < 0 ? 'off' : `day ${options.config.weeklyDay}`}`)
    },
    stop() {
      if (closed) return
      closed = true
      if (initialTimer !== null) clearTimeout(initialTimer)
      if (intervalTimer !== null) clearInterval(intervalTimer)
      initialTimer = null
      intervalTimer = null
      store.close()
    },
    runOnce,
  }
}
