/**
 * P6-3 trace metrics (docs/15 §十五).
 *
 * Pure aggregation over the two read models (`trace_events` + `task_attempts`)
 * so `scripts/trace.mjs stats` and the weekly patrol section share one shape.
 * No I/O here: the caller decides the window and how many rows to load.
 */

import type { TaskAttempt, TraceEventRecord } from './store.js'

export interface TraceErrorCount {
  code: string
  count: number
}

export interface TracePhaseCount {
  phase: string
  count: number
}

export interface TraceMetrics {
  events: number
  errorEvents: number
  attempts: number
  failedAttempts: number
  /** Descending by count, then code. Empty when nothing failed. */
  errorCodes: TraceErrorCount[]
  /** Descending by count, then phase. Empty when nothing failed. */
  failurePhases: TracePhaseCount[]
  durationP50Ms: number | null
  durationP95Ms: number | null
  toolCalls: number
  toolFailures: number
  executorRuns: number
  executorFailures: number
  /** Failed attempts that carry both `errorCode` and `traceId` (target: all). */
  diagnosable: number
  /** `diagnosable / failedAttempts`; null when nothing failed. */
  diagnosableRate: number | null
}

export const PHASE_LABELS: Record<string, string> = {
  message: '接入',
  task: '任务',
  execute: '执行',
  tool: '工具',
  verify: '验证',
  isolation: '隔离',
  merge: '合并',
  delivery: '投递',
}

const MAX_LISTED = 3

/** Nearest-rank percentile; ignores non-finite/negative values. */
export function percentile(values: number[], p: number): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

function attemptDurationMs(attempt: TaskAttempt): number | null {
  if (attempt.finishedAt === null) return null
  const started = Date.parse(attempt.startedAt)
  const finished = Date.parse(attempt.finishedAt)
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return null
  return finished - started
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function ranked(counts: Map<string, number>): Array<{ key: string; count: number }> {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

export function computeTraceMetrics(input: {
  events: TraceEventRecord[]
  attempts?: TaskAttempt[]
}): TraceMetrics {
  const { events } = input
  const attempts = input.attempts ?? []
  const errorEvents = events.filter((event) => event.level === 'error')

  const codeCounts = tally(
    errorEvents.flatMap((event) => (event.error?.code == null ? [] : [event.error.code])),
  )
  const phaseCounts = tally(errorEvents.map((event) => event.phase))

  const finished = attempts
    .map(attemptDurationMs)
    .filter((value): value is number => value !== null)
  // Attempts carry the wall-clock; the event timeline is the fallback when the
  // retention window or a disabled store left no attempt rows.
  const durations = finished.length > 0
    ? finished
    : events
        .filter((event) => event.event === 'attempt.finished' || event.event === 'executor.finished')
        .map((event) => event.durationMs)
        .filter((value): value is number => value !== null)

  const toolResults = events.filter((event) => event.event === 'tool.result')
  const toolFailures = toolResults.filter(
    (event) => event.status === 'failed' || (event.tool?.exitCode ?? 0) !== 0,
  ).length
  const executorRuns = events.filter((event) => event.event === 'executor.finished')
  const executorFailures = executorRuns.filter(
    (event) => event.level === 'error' || event.status === 'failed',
  ).length

  const failed = attempts.filter((attempt) => attempt.outcome === 'failed')
  const diagnosable = failed.filter(
    (attempt) => attempt.errorCode !== null && attempt.traceId.trim() !== '',
  ).length

  return {
    events: events.length,
    errorEvents: errorEvents.length,
    attempts: attempts.length,
    failedAttempts: failed.length,
    errorCodes: ranked(codeCounts).map((entry) => ({ code: entry.key, count: entry.count })),
    failurePhases: ranked(phaseCounts).map((entry) => ({ phase: entry.key, count: entry.count })),
    durationP50Ms: percentile(durations, 50),
    durationP95Ms: percentile(durations, 95),
    toolCalls: toolResults.length,
    toolFailures,
    executorRuns: executorRuns.length,
    executorFailures,
    diagnosable,
    diagnosableRate: failed.length === 0 ? null : diagnosable / failed.length,
  }
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return '-'
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase
}

/** Three compact lines for the weekly report; `null` keeps a quiet week silent. */
export function formatTraceWeekly(metrics: TraceMetrics): string | null {
  if (metrics.events === 0 && metrics.attempts === 0) return null

  const diagnosable = metrics.diagnosableRate === null
    ? '可诊断 -'
    : `可诊断 ${metrics.diagnosable}/${metrics.failedAttempts}（${Math.round(metrics.diagnosableRate * 100)}%）`
  const head = `轨迹：事件 ${metrics.events} · attempt ${metrics.attempts} · 失败 ${metrics.failedAttempts} · ${diagnosable}`

  const codes = metrics.errorCodes.slice(0, MAX_LISTED)
    .map((entry) => `${entry.code} ${entry.count}`)
    .join(' · ')
  const phases = metrics.failurePhases.slice(0, MAX_LISTED)
    .map((entry) => `${phaseLabel(entry.phase)} ${entry.count}`)
    .join(' · ')
  const failure = [
    codes === '' ? '' : `错误 Top：${codes}`,
    phases === '' ? '' : `阶段：${phases}`,
  ].filter((part) => part !== '').join('；')

  const latency = [
    `时延 p50 ${formatDurationMs(metrics.durationP50Ms)} · p95 ${formatDurationMs(metrics.durationP95Ms)}`,
    `工具失败 ${metrics.toolFailures}/${metrics.toolCalls}`,
    `执行失败 ${metrics.executorFailures}/${metrics.executorRuns}`,
  ].join(' · ')

  return [head, failure, latency].filter((line) => line !== '').join('\n')
}
