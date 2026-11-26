/**
 * P6-2 diagnosis rendering (docs/15 §十四).
 *
 * Pure formatters so `/diag`, `/status`, failure receipts and owner alerts can
 * be verified without a live channel. Host wires the data in; nothing here
 * reads SQLite or telemetry directly.
 */

export interface DiagAttempt {
  attempt: number
  outcome: string
  failureKind: string | null
  errorCode: string | null
  summary: string | null
  traceId: string
  startedAt: string
  finishedAt: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
}

export interface DiagEvent {
  ts: string
  event: string
  level: string
  phase: string
  status: string | null
  durationMs: number | null
  error: { code: string | null; kind?: string | null } | null
  /** P7-1: 轨迹回流需要工具名与成败；诊断渲染不读这两个字段。 */
  tool?: { name?: string | null; exitCode?: number | null } | null
  taskId?: string | null
}

export interface DiagTelemetryStats {
  mode: string
  degraded: boolean
  diskRatio: number | null
  queueDepth: number
  events: number
  todayBytes: number
  dropped: Record<string, number>
}

/** Structural read surface the host needs; the real store satisfies it. */
export interface DiagTelemetryReader {
  attempts?(taskId: string): DiagAttempt[]
  query?(input: {
    taskId?: string
    traceId?: string
    level?: string
    from?: string
    to?: string
    limit?: number
  }): { rows: DiagEvent[] }
  stats?(): DiagTelemetryStats
}

export interface DiagTask {
  id: string
  taskRef: string | null
  status: string
  attempt: number
  maxAttempts: number
  round: number
  correlationId: string
  riskLevel: string
  /** Slice CH (O1): explicit expert, when one was chosen. */
  expert?: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
}

const PHASE_LABELS: Record<string, string> = {
  ingest: '接入',
  task: '任务',
  attempt: '尝试',
  execute: '执行',
  tool: '工具调用',
  verify: '验证',
  isolation: '隔离',
  merge: '合并',
  deliver: '投递',
}

const ERROR_HINTS: Record<string, string> = {
  'expert-unavailable': '专家未注册，任务未执行',
  invalid_input: '输入不完整或无法解析',
  transient: '瞬时故障，可重试',
  timeout: '执行超时',
  'verification-failed': '验证未通过',
  'commit-failed': '工作区提交失败',
  'merge-conflict': '合并冲突',
  'merge-failed': '合并失败',
  'prepare-failed': '隔离准备失败',
  not_found: '工作区或目标不存在',
  needs_input: '需要补充信息',
  'foreground-unavailable': '前台不可用',
  'delivery-failed': '回执投递失败',
  'delivery-retry': '回执投递重试中',
}

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_input: '等待补充',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function phaseLabel(phase: string | null | undefined): string {
  if (phase === null || phase === undefined || phase === '') return '未知'
  return PHASE_LABELS[phase] ?? phase
}

export function statusLabel(status: string | null | undefined): string {
  if (status === null || status === undefined || status === '') return '已结束'
  return STATUS_LABELS[status] ?? status
}

/** Chat copy uses a short `tr_` handle; `/diag` prints the full trace id. */
export function shortTrace(traceId: string | null | undefined): string | null {
  if (typeof traceId !== 'string' || traceId === '') return null
  return `tr_${traceId.replace(/-/g, '').slice(0, 8)}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

export function taskRefOf(task: Pick<DiagTask, 'id' | 'taskRef'>): string {
  return task.taskRef ?? task.id.slice(0, 8)
}

/** `null` means the newest timestamp wins; `undefined` fields sort last. */
function newest(events: DiagEvent[], predicate: (event: DiagEvent) => boolean): DiagEvent | null {
  let found: DiagEvent | null = null
  for (const event of events) {
    if (!predicate(event)) continue
    if (found === null || event.ts >= found.ts) found = event
  }
  return found
}

/** The phase that actually failed; bookkeeping (`attempt`/`task`) never wins. */
const PHASE_RANK: Record<string, number> = {
  merge: 3,
  delivery: 3,
  isolation: 3,
  verify: 3,
  tool: 2,
  execute: 1,
  message: 1,
}

/**
 * Root cause = highest-specificity error, earliest on ties. A prepare failure
 * writes both `isolation.prepare.failed` and a wrapper `executor.finished`;
 * the isolation row is what the user needs to see.
 */
function rootError(events: DiagEvent[]): DiagEvent | null {
  let found: DiagEvent | null = null
  let best = -1
  for (const event of events) {
    if (event.level !== 'error' || event.phase === 'attempt' || event.phase === 'task') continue
    const rank = PHASE_RANK[event.phase] ?? 0
    if (rank > best || (rank === best && (found === null || event.ts < found.ts))) {
      found = event
      best = rank
    }
  }
  return found
}

export interface DiagReportInput {
  task: DiagTask
  attempts: DiagAttempt[]
  events: DiagEvent[]
  now: Date
  /** False when `DSH_WFXM_TRACE=off` or no reader was injected. */
  hasTelemetry: boolean
}

export function formatDiagReport(input: DiagReportInput): string {
  const { task, attempts, events, now } = input
  const ref = taskRefOf(task)
  const lines = [`任务 ${ref} ${statusLabel(task.status)}。`]
  const latest = attempts.length === 0 ? null : attempts[attempts.length - 1]
  const attemptNo = latest?.attempt ?? task.attempt

  lines.push(`状态：${task.status} · 第 ${attemptNo}/${task.maxAttempts} 次尝试`
    + (task.round > 0 ? ` · 轮次 ${task.round}` : ''))
  if (typeof task.expert === 'string' && task.expert !== '') lines.push(`专家：${task.expert}`)

  if (!input.hasTelemetry) {
    lines.push('诊断数据未启用（DSH_WFXM_TRACE=off 或未注入遥测）。')
    return lines.join('\n')
  }

  // Prefer the failure's real phase (execute/verify/isolation/merge) over the
  // generic attempt/task bookkeeping events, which share the same timestamp.
  const lastError = rootError(events)
    ?? newest(events, (event) => event.level === 'error')
  const failedAttempt = latest !== null && latest.outcome === 'failed' ? latest : null
  const phase = lastError?.phase ?? null
  const errorCode = lastError?.error?.code ?? failedAttempt?.errorCode ?? null
  const failureKind = failedAttempt?.failureKind ?? null
  if (phase !== null || errorCode !== null || failureKind !== null) {
    if (phase !== null) lines.push(`阶段：${phaseLabel(phase)}（${phase}）`)
    if (errorCode !== null) {
      const hint = ERROR_HINTS[errorCode]
      const suffix = failureKind !== null && failureKind !== errorCode ? ` · ${failureKind}` : ''
      lines.push(`原因：${errorCode}${hint === undefined ? '' : `（${hint}）`}${suffix}`)
    } else if (failureKind !== null) {
      lines.push(`原因：${failureKind}`)
    }
  }

  const lastStep = newest(events, (event) => event.level !== 'error'
    && (event.event === 'executor.step'
      || event.event === 'tool.result'
      || event.event === 'verify.succeeded'
      || event.event === 'isolation.commit.succeeded'))
  if (lastStep !== null) lines.push(`最后成功：${lastStep.event}`)

  const started = task.startedAt === null ? null : Date.parse(task.startedAt)
  const finished = task.finishedAt === null ? null : Date.parse(task.finishedAt)
  if (started !== null && finished !== null && finished >= started) {
    lines.push(`耗时：${formatDuration(finished - started)}`)
  }

  const traceId = latest?.traceId ?? task.correlationId
  if (traceId !== '') lines.push(`追踪：${traceId}`)

  if (errorCode === null && failureKind === null && task.status !== 'failed') {
    const quiet = lastError === null && lastStep !== null
      ? `最后事件：${lastStep.event}（${formatDuration(Math.max(0, now.getTime() - Date.parse(lastStep.ts)))} 前）`
      : null
    if (quiet !== null) lines.push(quiet)
    lines.push('无异常。')
  }
  return lines.join('\n')
}

export interface StuckTask {
  task: DiagTask
  quietMs: number
}

export interface FailureWindow {
  failed: number
  total: number
}

/** Failures and terminal volume from `task.settled` events in the window. */
export function summarizeFailures(events: DiagEvent[]): FailureWindow {
  let failed = 0
  let total = 0
  for (const event of events) {
    if (event.event !== 'task.settled') continue
    total += 1
    if (event.status === 'failed') failed += 1
  }
  return { failed, total }
}

export function isStuck(input: {
  task: DiagTask
  lastActivityAt: string | null
  now: Date
  thresholdMs: number
}): boolean {
  if (input.task.status !== 'running') return false
  const anchor = input.lastActivityAt ?? input.task.startedAt ?? input.task.createdAt
  const at = Date.parse(anchor)
  if (!Number.isFinite(at)) return false
  return input.now.getTime() - at >= input.thresholdMs
}

export interface StatusReportInput {
  halted: boolean
  tasks: DiagTask[]
  failures: FailureWindow
  stuck: StuckTask[]
  telemetry: DiagTelemetryStats | null
  now: Date
}

function countStatus(tasks: DiagTask[], status: string): number {
  return tasks.filter((task) => task.status === status).length
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function formatStatusReport(input: StatusReportInput): string {
  const lines = [`服务：${input.halted ? '已全局停止' : '运行中'}`]
  lines.push(`任务：running ${countStatus(input.tasks, 'running')}`
    + ` · queued ${countStatus(input.tasks, 'queued')}`
    + ` · waiting_input ${countStatus(input.tasks, 'waiting_input')}`
    + ` · waiting_approval ${countStatus(input.tasks, 'waiting_approval')}`)
  const pct = input.failures.total === 0
    ? '—'
    : `${Math.round((input.failures.failed / input.failures.total) * 100)}%`
  lines.push(`近 1 小时：失败 ${input.failures.failed} / ${input.failures.total}（${pct}）`)
  lines.push(input.stuck.length === 0
    ? '卡住：无'
    : `卡住：${input.stuck.slice(0, 3).map(({ task, quietMs }) => (
      `${taskRefOf(task)}（${Math.max(1, Math.round(quietMs / 60_000))} 分钟无事件）`
    )).join('、')}`)
  if (input.telemetry === null) {
    lines.push('遥测：未启用')
  } else {
    const dropped = Object.values(input.telemetry.dropped).reduce((sum, value) => sum + value, 0)
    lines.push(`遥测：${input.telemetry.mode}${input.telemetry.degraded ? '（降级）' : ''}`
      + ` · 丢弃 ${dropped} · 今日 ${formatBytes(input.telemetry.todayBytes)}`)
  }
  return lines.join('\n')
}

/** Group `error` events by code; newest task id is useful for the alert link. */
export function groupErrorCodes(events: DiagEvent[]): Array<{
  code: string
  count: number
  latestTaskId: string | null
}> {
  const groups = new Map<string, { count: number; latestTaskId: string | null; latestTs: string }>()
  for (const event of events) {
    const code = event.error?.code
    if (event.level !== 'error' || code === null || code === undefined) continue
    const taskId = event.taskId ?? null
    const current = groups.get(code)
    if (current === undefined) {
      groups.set(code, { count: 1, latestTaskId: taskId, latestTs: event.ts })
      continue
    }
    current.count += 1
    if (event.ts >= current.latestTs) {
      current.latestTs = event.ts
      current.latestTaskId = taskId
    }
  }
  return [...groups.entries()]
    .map(([code, value]) => ({ code, count: value.count, latestTaskId: value.latestTaskId }))
    .sort((a, b) => b.count - a.count)
}

export function formatStuckAlert(task: DiagTask, quietMs: number): string {
  return `任务 ${taskRefOf(task)} 已 ${Math.max(1, Math.round(quietMs / 60_000))} 分钟无新事件`
    + `（${task.status} · 第 ${task.attempt} 次尝试）。发送 /diag ${taskRefOf(task)} 查看。`
}

export function formatRepeatAlert(code: string, count: number, ref: string): string {
  return `错误码 ${code} 近 1 小时出现 ${count} 次（最近任务 ${ref}）。发送 /diag ${ref} 查看。`
}

/**
 * P6-2: join a failed receipt with its latest attempt and the error phase.
 * Any telemetry failure returns the row untouched — a receipt must still go out.
 */
export function enrichFailureReceipt<T extends { taskId: string; status?: string | null }>(
  row: T,
  reader: DiagTelemetryReader | null | undefined,
): T {
  if (reader?.attempts === undefined || row.status !== 'failed') return row
  try {
    const attempts = reader.attempts(row.taskId)
    if (attempts.length === 0) return row
    const latest = attempts[attempts.length - 1]
    const errors = reader.query?.({ taskId: row.taskId, level: 'error', limit: 20 }).rows ?? []
    // Same preference as `/diag`: the specific failure phase (verify/execute/
    // isolation) beats the attempt/task bookkeeping error written last.
    const primary = rootError(errors) ?? errors[0]
    return {
      ...row,
      failurePhase: primary === undefined ? null : primary.phase,
      errorCode: primary?.error?.code ?? latest.errorCode,
      failureKind: latest.failureKind,
      attempt: latest.attempt,
      traceId: latest.traceId,
    }
  } catch {
    return row
  }
}
