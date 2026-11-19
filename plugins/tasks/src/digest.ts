/**
 * Task digest (docs/05 Step 4 G3): a deterministic, model-free summary of what
 * the assistant did in a window. It reads only `TaskStore.listTasks()` output —
 * no table access, no inference, no state change.
 *
 * Window rules (deliberate, so the numbers are explainable):
 * - finished work is counted by `finishedAt` inside the window;
 * - live work (`queued|running|waiting_approval|waiting_input|paused`) is a
 *   snapshot of "now", regardless of when it was created.
 */

import type { Task, TaskStatus } from './model.js'

export interface TaskDigestWindow {
  from: Date
  to: Date
  /** Max bullet lines after the counts (default 5). */
  maxLines?: number
  /** Replaces `任务日报 MM-DD` (weekly report reuses the same counts). */
  title?: string
}

export interface TaskDigestCounts {
  succeeded: number
  failed: number
  cancelled: number
  paused: number
  running: number
  queued: number
  waitingApproval: number
  waitingInput: number
}

export interface TaskDigestUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface TaskDigest {
  counts: TaskDigestCounts
  total: number
  /** Slice BK (I5): summed usage for the tasks counted in this window. */
  usage: TaskDigestUsage
  /** Bullet lines, newest/most notable first. */
  lines: string[]
  text: string
}

const FINISHED: ReadonlySet<TaskStatus> = new Set(['succeeded', 'failed', 'cancelled'])
const MAX_INTENT = 40

function emptyCounts(): TaskDigestCounts {
  return {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    paused: 0,
    running: 0,
    queued: 0,
    waitingApproval: 0,
    waitingInput: 0,
  }
}

function inWindow(value: string | null, from: Date, to: Date): boolean {
  if (value === null) return false
  const at = Date.parse(value)
  return Number.isFinite(at) && at >= from.getTime() && at <= to.getTime()
}

function label(status: TaskStatus): string {
  switch (status) {
    case 'succeeded': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'paused': return '已暂停'
    case 'running': return '进行中'
    case 'queued': return '排队'
    case 'waiting_approval': return '待批准'
    case 'waiting_input': return '待补充'
  }
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

function bullet(task: Task): string {
  const ref = task.taskRef ?? task.id.slice(0, 8)
  return `· ${ref} · ${label(task.status)} · ${oneLine(task.intent, MAX_INTENT)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

function usageSuffix(usage: TaskDigestUsage): string {
  if (usage.costUsd > 0) {
    const digits = usage.costUsd < 0.01 ? 4 : 2
    return `费用 $${usage.costUsd.toFixed(digits)}`
  }
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    return `tokens ${formatTokens(usage.inputTokens)}/${formatTokens(usage.outputTokens)}`
  }
  return ''
}

/**
 * Returns `null` when nothing happened and nothing is live — a daily message
 * saying "0 tasks" is noise, and noise is exactly what this feature avoids.
 */
export function summarizeTaskDigest(
  tasks: readonly Task[],
  window: TaskDigestWindow,
): TaskDigest | null {
  const counts = emptyCounts()
  const usage: TaskDigestUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  const finished: Task[] = []
  const live: Task[] = []

  for (const task of tasks) {
    if (task.createdAt !== null && Date.parse(task.createdAt) > window.to.getTime()) continue
    if (FINISHED.has(task.status)) {
      if (!inWindow(task.finishedAt, window.from, window.to)) continue
      finished.push(task)
      if (task.status === 'succeeded') counts.succeeded += 1
      else if (task.status === 'failed') counts.failed += 1
      else counts.cancelled += 1
    } else {
      live.push(task)
      if (task.status === 'paused') counts.paused += 1
      else if (task.status === 'running') counts.running += 1
      else if (task.status === 'queued') counts.queued += 1
      else if (task.status === 'waiting_approval') counts.waitingApproval += 1
      else if (task.status === 'waiting_input') counts.waitingInput += 1
    }
    usage.inputTokens += task.inputTokens ?? 0
    usage.outputTokens += task.outputTokens ?? 0
    usage.costUsd += task.costUsd ?? 0
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  if (total === 0) return null

  const parts: string[] = []
  if (counts.succeeded > 0) parts.push(`完成 ${counts.succeeded}`)
  if (counts.failed > 0) parts.push(`失败 ${counts.failed}`)
  if (counts.cancelled > 0) parts.push(`取消 ${counts.cancelled}`)
  if (counts.paused > 0) parts.push(`暂停 ${counts.paused}`)
  if (counts.waitingApproval > 0) parts.push(`待批准 ${counts.waitingApproval}`)
  if (counts.waitingInput > 0) parts.push(`待补充 ${counts.waitingInput}`)
  if (counts.running > 0) parts.push(`进行中 ${counts.running}`)
  if (counts.queued > 0) parts.push(`排队 ${counts.queued}`)

  const stamp = `${pad(window.to.getMonth() + 1)}-${pad(window.to.getDate())}`
  const suffix = usageSuffix(usage)
  const head = `${window.title ?? `任务日报 ${stamp}`}：${parts.join(' · ')}`
    + (suffix === '' ? '' : ` · ${suffix}`)

  const byFinished = finished.sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const notable = [...byFinished, ...live.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))]
  const maxLines = Math.max(0, Math.floor(window.maxLines ?? 5))
  const lines = notable.slice(0, maxLines).map(bullet)

  return {
    counts,
    total,
    usage,
    lines,
    text: lines.length === 0 ? head : `${head}\n${lines.join('\n')}`,
  }
}
