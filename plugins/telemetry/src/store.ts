/**
 * Telemetry store (module `telemetry`, docs/15 §十二).
 *
 * Owns four tables in `ops.sqlite`:
 *   - `trace_events`   structured event timeline (14-day retention)
 *   - `task_attempts`  one row per executor attempt (14-day retention)
 *   - `telemetry_usage` quota counters (`day:<date>` / `task:<id>`)
 *   - `telemetry_drops` drop counters, so "missing" is measurable
 *
 * Event writes are queued and flushed off the caller's stack. Every failure
 * path is accounted for in `telemetry_drops`; `emit()` never throws. Reads are
 * exposed through the store API so /diag and trace.mjs never join tables.
 */

import { mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { runMigrations } from '@dsh-wfxm/sql-migrate'
import { dayKey, uuidv7 } from './ids.js'
import {
  TELEMETRY_MESSAGE_LIMIT,
  TELEMETRY_STACK_LIMIT,
  normalizeTelemetryEvent,
  redactAttrsForStorage,
  redactForStorage,
  resolveTelemetryMode,
  toIsoTime,
  type NormalizedTelemetryEvent,
  type TelemetryEventInput,
  type TelemetryLevel,
  type TelemetryMode,
} from './event.js'

const MIGRATION_MODULE = 'telemetry'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export const DEFAULT_QUEUE_LIMIT = 1_000
export const DEFAULT_BATCH_SIZE = 200
export const DEFAULT_FLUSH_INTERVAL_MS = 250
export const DEFAULT_PER_TASK_LIMIT_BYTES = 2 * 1024 * 1024
export const DEFAULT_DAILY_LIMIT_BYTES = 200 * 1024 * 1024
export const DEFAULT_DISK_WARN_RATIO = 0.85
export const DEFAULT_RETENTION_DAYS = 14
export const DEFAULT_FILE_RETENTION_DAYS = 7

export type DropReason =
  | 'disabled'
  | 'invalid'
  | 'queue-full'
  | 'task-quota'
  | 'daily-quota'
  | 'store-error'
  | 'closed'

export type AttemptOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface DiskUsage {
  usedBytes: number
  totalBytes: number
}

export interface TelemetryStoreOptions {
  dbPath: string
  /** Day folders (`YYYYMMDD`) to prune; NDJSON writer lands in P6-1. */
  traceDir?: string
  /** Defaults to `DSH_WFXM_TRACE` (absent = meta). */
  mode?: TelemetryMode
  now?: () => Date
  /** Injected for tests; defaults to `statfsSync` on the trace/db directory. */
  diskUsage?: () => DiskUsage | null
  onError?: (error: unknown) => void
  queueLimit?: number
  batchSize?: number
  flushIntervalMs?: number
  /** SQLite busy wait; P6-4 drills lower it to surface SQLITE_BUSY quickly. */
  busyTimeoutMs?: number
  perTaskLimitBytes?: number
  dailyLimitBytes?: number
  diskWarnRatio?: number
  retentionDays?: number
  fileRetentionDays?: number
}

export interface FlushResult {
  written: number
  dropped: number
  errors: number
}

export interface TraceQueryInput {
  taskId?: string
  traceId?: string
  errorCode?: string
  level?: TelemetryLevel
  /** Inclusive ISO lower bound on `ts`. */
  from?: string
  /** Exclusive ISO upper bound on `ts`. */
  to?: string
  /** 1..5000; defaults to 100. Reports pass a larger limit explicitly. */
  limit?: number
}

export interface TraceErrorRecord {
  code: string | null
  kind: string | null
  messageDigest: string | null
  stackDigest: string | null
  retryable: boolean | null
  message: string | null
  stack: string | null
}

export interface TraceModelRecord {
  name: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
}

export interface TraceToolRecord {
  name: string | null
  argsDigest: string | null
  exitCode: number | null
  durationMs: number | null
}

export interface TraceEventRecord {
  id: string
  ts: string
  level: TelemetryLevel
  event: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  threadId: string | null
  messageId: string | null
  projectId: string | null
  taskId: string | null
  taskRef: string | null
  round: number | null
  attempt: number | null
  phase: string
  status: string | null
  durationMs: number | null
  error: TraceErrorRecord | null
  model: TraceModelRecord | null
  tool: TraceToolRecord | null
  attrs: Record<string, string | number | boolean | null> | null
  bytes: number
  createdAt: string
}

export interface TraceQueryResult {
  rows: TraceEventRecord[]
  count: number
}

export interface BeginAttemptInput {
  taskId: string
  attempt: number
  traceId: string
  executor?: string
  model?: string
  sessionRef?: string
  traceRef?: string
  startedAt?: string | number | Date
}

export interface FinishAttemptInput {
  outcome: Exclude<AttemptOutcome, 'running'>
  failureKind?: string
  errorCode?: string
  summary?: string
  finishedAt?: string | number | Date
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface AttemptWindowInput {
  /** Inclusive ISO lower bound on `started_at`. */
  from?: string
  /** Exclusive ISO upper bound on `started_at`. */
  to?: string
  /** 1..5000; defaults to 1000. */
  limit?: number
}

export interface TaskAttempt {
  id: string
  taskId: string
  attempt: number
  traceId: string
  executor: string | null
  model: string | null
  startedAt: string
  finishedAt: string | null
  outcome: AttemptOutcome
  failureKind: string | null
  errorCode: string | null
  summary: string | null
  sessionRef: string | null
  traceRef: string | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  createdAt: string
  updatedAt: string
}

export interface TelemetryStats {
  mode: TelemetryMode
  degraded: boolean
  diskRatio: number | null
  queueDepth: number
  events: number
  todayBytes: number
  dropped: Record<string, number>
  lastFlushAt: string | null
}

export interface PruneResult {
  events: number
  attempts: number
  usage: number
  drops: number
  files: number
}

export interface TelemetryStore {
  /** Non-blocking: validates, enqueues, and never throws. `false` = dropped. */
  emit(event: TelemetryEventInput): boolean
  flush(): Promise<FlushResult>
  beginAttempt(input: BeginAttemptInput): TaskAttempt
  finishAttempt(taskId: string, attempt: number, input: FinishAttemptInput): boolean
  getAttempt(taskId: string, attempt: number): TaskAttempt | null
  attempts(taskId: string): TaskAttempt[]
  /** Attempts whose `started_at` falls in the window, newest first (reports/stats). */
  attemptsSince(input?: AttemptWindowInput): TaskAttempt[]
  query(input?: TraceQueryInput): TraceQueryResult
  stats(): TelemetryStats
  prune(input?: { now?: Date }): PruneResult
  close(): void
}

interface TraceRow {
  id: string
  ts: string
  level: TelemetryLevel
  event: string
  trace_id: string
  span_id: string
  parent_span_id: string | null
  thread_id: string | null
  message_id: string | null
  project_id: string | null
  task_id: string | null
  task_ref: string | null
  round: number | null
  attempt: number | null
  phase: string
  status: string | null
  duration_ms: number | null
  error_code: string | null
  error_kind: string | null
  error_message_digest: string | null
  error_stack_digest: string | null
  error_retryable: number | null
  error_message: string | null
  error_stack: string | null
  model_name: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  tool_name: string | null
  tool_args_digest: string | null
  tool_exit_code: number | null
  tool_duration_ms: number | null
  attrs_json: string | null
  bytes: number
  created_at: string
}

interface AttemptRow {
  id: string
  task_id: string
  attempt: number
  trace_id: string
  executor: string | null
  model: string | null
  started_at: string
  finished_at: string | null
  outcome: AttemptOutcome
  failure_kind: string | null
  error_code: string | null
  summary: string | null
  session_ref: string | null
  trace_ref: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  created_at: string
  updated_at: string
}

interface UsageCounter {
  bytes: number
  events: number
}

interface DropAggregate {
  count: number
  bytes: number
}

function migrate(db: Database): void {
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

function defaultDiskUsage(path: string): DiskUsage | null {
  try {
    const stats = statfsSync(path)
    const totalBytes = stats.blocks * stats.bsize
    if (totalBytes <= 0) return null
    return { usedBytes: totalBytes - stats.bavail * stats.bsize, totalBytes }
  } catch {
    return null
  }
}

function pruneTraceFiles(dir: string, cutoffDay: string): number {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{8}$/.test(entry.name)) continue
    const day = `${entry.name.slice(0, 4)}-${entry.name.slice(4, 6)}-${entry.name.slice(6, 8)}`
    if (day < cutoffDay) {
      rmSync(join(dir, entry.name), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

function estimateBytes(row: Omit<TraceRow, 'bytes'>): number {
  const parts: Array<string | number | null> = [
    row.ts,
    row.level,
    row.event,
    row.trace_id,
    row.span_id,
    row.parent_span_id,
    row.thread_id,
    row.message_id,
    row.project_id,
    row.task_id,
    row.task_ref,
    row.round,
    row.attempt,
    row.phase,
    row.status,
    row.duration_ms,
    row.error_code,
    row.error_kind,
    row.error_message_digest,
    row.error_stack_digest,
    row.error_retryable,
    row.error_message,
    row.error_stack,
    row.model_name,
    row.input_tokens,
    row.output_tokens,
    row.cost_usd,
    row.tool_name,
    row.tool_args_digest,
    row.tool_exit_code,
    row.tool_duration_ms,
    row.attrs_json,
  ]
  return Buffer.byteLength(parts.filter((part) => part !== null).join('|'), 'utf8')
}

function buildTraceRow(
  event: NormalizedTelemetryEvent,
  mode: TelemetryMode,
  ingestedAt: Date,
): TraceRow {
  const full = mode === 'full'
  const errorMessage =
    full && event.error !== null && event.error.message !== null
      ? redactForStorage(event.error.message, TELEMETRY_MESSAGE_LIMIT)
      : null
  const errorStack =
    full && event.error !== null && event.error.stack !== null
      ? redactForStorage(event.error.stack, TELEMETRY_STACK_LIMIT)
      : null
  const attrsJson =
    full && event.attrs !== null ? JSON.stringify(redactAttrsForStorage(event.attrs)) : null

  const base: Omit<TraceRow, 'bytes'> = {
    id: uuidv7(ingestedAt.getTime()),
    ts: event.ts,
    level: event.level,
    event: event.event,
    trace_id: event.traceId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId,
    thread_id: event.threadId,
    message_id: event.messageId,
    project_id: event.projectId,
    task_id: event.taskId,
    task_ref: event.taskRef,
    round: event.round,
    attempt: event.attempt,
    phase: event.phase,
    status: event.status,
    duration_ms: event.durationMs,
    error_code: event.error?.code ?? null,
    error_kind: event.error?.kind ?? null,
    error_message_digest: event.error?.messageDigest ?? null,
    error_stack_digest: event.error?.stackDigest ?? null,
    error_retryable:
      event.error === null || event.error.retryable === null
        ? null
        : event.error.retryable
          ? 1
          : 0,
    error_message: errorMessage,
    error_stack: errorStack,
    model_name: event.model?.name ?? null,
    input_tokens: event.model?.inputTokens ?? null,
    output_tokens: event.model?.outputTokens ?? null,
    cost_usd: event.model?.costUsd ?? null,
    tool_name: event.tool?.name ?? null,
    tool_args_digest: event.tool?.argsDigest ?? null,
    tool_exit_code: event.tool?.exitCode ?? null,
    tool_duration_ms: event.tool?.durationMs ?? null,
    attrs_json: attrsJson,
    created_at: ingestedAt.toISOString(),
  }
  return { ...base, bytes: estimateBytes(base) }
}

function parseAttrs(value: string | null): Record<string, string | number | boolean | null> | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, string | number | boolean | null>)
      : null
  } catch {
    return null
  }
}

function toTraceRecord(row: TraceRow): TraceEventRecord {
  const hasError =
    row.error_code !== null ||
    row.error_kind !== null ||
    row.error_message_digest !== null ||
    row.error_stack_digest !== null ||
    row.error_retryable !== null ||
    row.error_message !== null ||
    row.error_stack !== null
  const hasModel =
    row.model_name !== null ||
    row.input_tokens !== null ||
    row.output_tokens !== null ||
    row.cost_usd !== null
  const hasTool =
    row.tool_name !== null ||
    row.tool_args_digest !== null ||
    row.tool_exit_code !== null ||
    row.tool_duration_ms !== null
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    event: row.event,
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskRef: row.task_ref,
    round: row.round,
    attempt: row.attempt,
    phase: row.phase,
    status: row.status,
    durationMs: row.duration_ms,
    error: hasError
      ? {
          code: row.error_code,
          kind: row.error_kind,
          messageDigest: row.error_message_digest,
          stackDigest: row.error_stack_digest,
          retryable: row.error_retryable === null ? null : row.error_retryable === 1,
          message: row.error_message,
          stack: row.error_stack,
        }
      : null,
    model: hasModel
      ? {
          name: row.model_name,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          costUsd: row.cost_usd,
        }
      : null,
    tool: hasTool
      ? {
          name: row.tool_name,
          argsDigest: row.tool_args_digest,
          exitCode: row.tool_exit_code,
          durationMs: row.tool_duration_ms,
        }
      : null,
    attrs: parseAttrs(row.attrs_json),
    bytes: row.bytes,
    createdAt: row.created_at,
  }
}

function toAttempt(row: AttemptRow): TaskAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    traceId: row.trace_id,
    executor: row.executor,
    model: row.model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    failureKind: row.failure_kind,
    errorCode: row.error_code,
    summary: row.summary,
    sessionRef: row.session_ref,
    traceRef: row.trace_ref,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function requiredText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${field} must not be empty`)
  return trimmed
}

export function createTelemetryStore(options: TelemetryStoreOptions): TelemetryStore {
  const mode = options.mode ?? resolveTelemetryMode()
  const now = options.now ?? (() => new Date())
  const queueLimit = Math.max(1, Math.trunc(options.queueLimit ?? DEFAULT_QUEUE_LIMIT))
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE))
  const flushIntervalMs = Math.max(1, Math.trunc(options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS))
  const perTaskLimitBytes = Math.max(1, Math.trunc(options.perTaskLimitBytes ?? DEFAULT_PER_TASK_LIMIT_BYTES))
  const dailyLimitBytes = Math.max(1, Math.trunc(options.dailyLimitBytes ?? DEFAULT_DAILY_LIMIT_BYTES))
  const diskWarnRatio = options.diskWarnRatio ?? DEFAULT_DISK_WARN_RATIO
  const retentionDays = Math.max(1, Math.trunc(options.retentionDays ?? DEFAULT_RETENTION_DAYS))
  const fileRetentionDays = Math.max(1, Math.trunc(options.fileRetentionDays ?? DEFAULT_FILE_RETENTION_DAYS))
  const traceDir = options.traceDir ?? null

  if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true })
  const db = new DatabaseConstructor(options.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5_000))}`)
  migrate(db)

  const insertEvent = db.prepare(`
    INSERT INTO trace_events (
      id, ts, level, event, trace_id, span_id, parent_span_id, thread_id, message_id,
      project_id, task_id, task_ref, round, attempt, phase, status, duration_ms,
      error_code, error_kind, error_message_digest, error_stack_digest, error_retryable,
      error_message, error_stack, model_name, input_tokens, output_tokens, cost_usd,
      tool_name, tool_args_digest, tool_exit_code, tool_duration_ms, attrs_json, bytes, created_at
    ) VALUES (
      @id, @ts, @level, @event, @trace_id, @span_id, @parent_span_id, @thread_id, @message_id,
      @project_id, @task_id, @task_ref, @round, @attempt, @phase, @status, @duration_ms,
      @error_code, @error_kind, @error_message_digest, @error_stack_digest, @error_retryable,
      @error_message, @error_stack, @model_name, @input_tokens, @output_tokens, @cost_usd,
      @tool_name, @tool_args_digest, @tool_exit_code, @tool_duration_ms, @attrs_json, @bytes, @created_at
    )
  `)
  const selectUsage = db.prepare('SELECT bytes, events FROM telemetry_usage WHERE key = ?')
  const upsertUsage = db.prepare(`
    INSERT INTO telemetry_usage(key, bytes, events, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      bytes = excluded.bytes, events = excluded.events, updated_at = excluded.updated_at
  `)
  const upsertDrop = db.prepare(`
    INSERT INTO telemetry_drops(day, reason, count, bytes, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, reason) DO UPDATE SET
      count = telemetry_drops.count + excluded.count,
      bytes = telemetry_drops.bytes + excluded.bytes,
      updated_at = excluded.updated_at
  `)
  const selectAttempt = db.prepare(
    'SELECT * FROM task_attempts WHERE task_id = ? AND attempt = ?',
  )
  const selectAttempts = db.prepare(
    'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC',
  )
  const selectAttemptsSince = db.prepare(`
    SELECT * FROM task_attempts
    WHERE (@from IS NULL OR started_at >= @from)
      AND (@to IS NULL OR started_at < @to)
    ORDER BY started_at DESC
    LIMIT @limit
  `)
  const insertAttempt = db.prepare(`
    INSERT INTO task_attempts (
      id, task_id, attempt, trace_id, executor, model, started_at, finished_at, outcome,
      failure_kind, error_code, summary, session_ref, trace_ref, input_tokens, output_tokens,
      cost_usd, created_at, updated_at
    ) VALUES (
      @id, @task_id, @attempt, @trace_id, @executor, @model, @started_at, NULL, 'running',
      NULL, NULL, NULL, @session_ref, @trace_ref, NULL, NULL, NULL, @created_at, @updated_at
    )
    ON CONFLICT(task_id, attempt) DO UPDATE SET
      trace_id = excluded.trace_id,
      executor = COALESCE(excluded.executor, task_attempts.executor),
      model = COALESCE(excluded.model, task_attempts.model),
      session_ref = COALESCE(excluded.session_ref, task_attempts.session_ref),
      trace_ref = COALESCE(excluded.trace_ref, task_attempts.trace_ref),
      updated_at = excluded.updated_at
  `)
  const finishAttemptStmt = db.prepare(`
    UPDATE task_attempts SET
      outcome = @outcome,
      failure_kind = @failure_kind,
      error_code = @error_code,
      summary = @summary,
      finished_at = @finished_at,
      model = COALESCE(@model, model),
      input_tokens = COALESCE(@input_tokens, input_tokens),
      output_tokens = COALESCE(@output_tokens, output_tokens),
      cost_usd = COALESCE(@cost_usd, cost_usd),
      updated_at = @updated_at
    WHERE task_id = @task_id AND attempt = @attempt AND outcome = 'running'
  `)

  const queue: NormalizedTelemetryEvent[] = []
  const pendingDrops = new Map<DropReason, DropAggregate>()
  const usageCache = new Map<string, UsageCounter>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let immediate: ReturnType<typeof setImmediate> | null = null
  let closed = false
  let lastFlushAt: string | null = null

  const diskBasePath =
    options.dbPath === ':memory:' ? process.cwd() : dirname(options.dbPath)

  function readDiskRatio(): number | null {
    const usage =
      options.diskUsage !== undefined ? options.diskUsage() : defaultDiskUsage(traceDir ?? diskBasePath)
    if (usage === null || usage.totalBytes <= 0) return null
    return usage.usedBytes / usage.totalBytes
  }

  function clearTimers(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (immediate !== null) {
      clearImmediate(immediate)
      immediate = null
    }
  }

  function scheduleFlush(): void {
    if (closed || timer !== null || immediate !== null) return
    timer = setTimeout(() => {
      timer = null
      flushNow()
    }, flushIntervalMs)
    timer.unref()
  }

  function scheduleImmediate(): void {
    if (closed || immediate !== null) return
    immediate = setImmediate(() => {
      immediate = null
      flushNow()
    })
    immediate.unref()
  }

  function noteDrop(reason: DropReason, bytes = 0): void {
    const current = pendingDrops.get(reason) ?? { count: 0, bytes: 0 }
    current.count += 1
    current.bytes += bytes
    pendingDrops.set(reason, current)
    scheduleFlush()
  }

  function addAggregate(
    target: Map<DropReason, DropAggregate>,
    reason: DropReason,
    count: number,
    bytes: number,
  ): void {
    const current = target.get(reason) ?? { count: 0, bytes: 0 }
    current.count += count
    current.bytes += bytes
    target.set(reason, current)
  }

  function readUsage(key: string): UsageCounter {
    const row = selectUsage.get(key) as { bytes: number; events: number } | undefined
    return row === undefined ? { bytes: 0, events: 0 } : { bytes: row.bytes, events: row.events }
  }

  function flushNow(): FlushResult {
    if (closed) return { written: 0, dropped: 0, errors: 0 }
    clearTimers()
    const batch = queue.splice(0, queue.length)
    const inherited = new Map(pendingDrops)
    pendingDrops.clear()
    if (batch.length === 0 && inherited.size === 0) return { written: 0, dropped: 0, errors: 0 }

    const ingestedAt = now()
    const day = dayKey(ingestedAt)
    const dayCounterKey = `day:${day}`
    const ratio = readDiskRatio()
    const effectiveMode: TelemetryMode =
      mode === 'full' && ratio !== null && ratio >= diskWarnRatio ? 'meta' : mode
    const localUsage = new Map<string, UsageCounter>()
    const touched = new Set<string>()
    const drops = new Map(inherited)
    let written = 0
    let dropped = 0

    const loadCounter = (key: string): UsageCounter => {
      const existing = localUsage.get(key)
      if (existing !== undefined) return existing
      const cached = usageCache.get(key)
      const counter = cached === undefined ? readUsage(key) : { ...cached }
      localUsage.set(key, counter)
      return counter
    }

    try {
      const write = db.transaction(() => {
        for (const event of batch) {
          const row = buildTraceRow(event, effectiveMode, ingestedAt)
          if (row.task_id !== null) {
            const taskKey = `task:${row.task_id}`
            if (loadCounter(taskKey).bytes + row.bytes > perTaskLimitBytes) {
              addAggregate(drops, 'task-quota', 1, row.bytes)
              dropped += 1
              continue
            }
          }
          if (loadCounter(dayCounterKey).bytes + row.bytes > dailyLimitBytes) {
            addAggregate(drops, 'daily-quota', 1, row.bytes)
            dropped += 1
            continue
          }
          insertEvent.run(row)
          written += 1
          const dayCounter = loadCounter(dayCounterKey)
          dayCounter.bytes += row.bytes
          dayCounter.events += 1
          touched.add(dayCounterKey)
          if (row.task_id !== null) {
            const taskKey = `task:${row.task_id}`
            const taskCounter = loadCounter(taskKey)
            taskCounter.bytes += row.bytes
            taskCounter.events += 1
            touched.add(taskKey)
          }
        }
        const updatedAt = ingestedAt.toISOString()
        for (const key of touched) {
          const counter = localUsage.get(key)
          if (counter !== undefined) upsertUsage.run(key, counter.bytes, counter.events, updatedAt)
        }
        for (const [reason, aggregate] of drops) {
          upsertDrop.run(day, reason, aggregate.count, aggregate.bytes, updatedAt)
        }
      })
      write.immediate()
      for (const key of touched) {
        const counter = localUsage.get(key)
        if (counter !== undefined) usageCache.set(key, counter)
      }
      lastFlushAt = ingestedAt.toISOString()
      return { written, dropped, errors: 0 }
    } catch (error) {
      // Put unwritten counters back and account the lost batch. No rescheduling:
      // a broken database must not spin.
      for (const [reason, aggregate] of inherited) {
        addAggregate(pendingDrops, reason, aggregate.count, aggregate.bytes)
      }
      for (const [reason, aggregate] of drops) {
        if (!inherited.has(reason)) addAggregate(pendingDrops, reason, aggregate.count, aggregate.bytes)
      }
      addAggregate(pendingDrops, 'store-error', batch.length, 0)
      options.onError?.(error)
      return { written: 0, dropped: dropped + batch.length, errors: 1 }
    }
  }

  function emit(input: TelemetryEventInput): boolean {
    try {
      if (closed) {
        noteDrop('closed')
        return false
      }
      if (mode === 'off') {
        noteDrop('disabled')
        return false
      }
      const event = normalizeTelemetryEvent(input, now())
      if (queue.length >= queueLimit) {
        noteDrop('queue-full')
        return false
      }
      queue.push(event)
      if (queue.length >= batchSize) scheduleImmediate()
      else scheduleFlush()
      return true
    } catch {
      noteDrop('invalid')
      return false
    }
  }

  function beginAttempt(input: BeginAttemptInput): TaskAttempt {
    const taskId = requiredText(input.taskId, 'taskId')
    const traceId = requiredText(input.traceId, 'traceId')
    if (!Number.isInteger(input.attempt) || input.attempt < 0) {
      throw new Error('attempt must be a non-negative integer')
    }
    const timestamp = now()
    insertAttempt.run({
      id: uuidv7(timestamp.getTime()),
      task_id: taskId,
      attempt: input.attempt,
      trace_id: traceId,
      executor: input.executor ?? null,
      model: input.model ?? null,
      started_at: toIsoTime(input.startedAt, timestamp),
      session_ref: input.sessionRef ?? null,
      trace_ref: input.traceRef ?? null,
      created_at: timestamp.toISOString(),
      updated_at: timestamp.toISOString(),
    })
    const attempt = getAttempt(taskId, input.attempt)
    if (attempt === null) throw new Error('attempt insert did not persist')
    return attempt
  }

  function finishAttempt(taskId: string, attempt: number, input: FinishAttemptInput): boolean {
    if (input.outcome !== 'succeeded' && input.outcome !== 'failed' && input.outcome !== 'cancelled') {
      throw new Error(`invalid attempt outcome: ${String(input.outcome)}`)
    }
    const result = finishAttemptStmt.run({
      task_id: taskId,
      attempt,
      outcome: input.outcome,
      failure_kind: input.failureKind ?? null,
      error_code: input.errorCode ?? null,
      summary: input.summary === undefined ? null : redactForStorage(input.summary, 500),
      finished_at: toIsoTime(input.finishedAt, now()),
      model: input.model ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      cost_usd: input.costUsd ?? null,
      updated_at: now().toISOString(),
    })
    return result.changes > 0
  }

  function getAttempt(taskId: string, attempt: number): TaskAttempt | null {
    const row = selectAttempt.get(taskId, attempt) as AttemptRow | undefined
    return row === undefined ? null : toAttempt(row)
  }

  function attempts(taskId: string): TaskAttempt[] {
    return (selectAttempts.all(taskId) as AttemptRow[]).map(toAttempt)
  }

  function attemptsSince(input: AttemptWindowInput = {}): TaskAttempt[] {
    const limit = Math.min(5_000, Math.max(1, Math.trunc(input.limit ?? 1_000)))
    const rows = selectAttemptsSince.all({
      from: input.from ?? null,
      to: input.to ?? null,
      limit,
    }) as AttemptRow[]
    return rows.map(toAttempt)
  }

  function query(input: TraceQueryInput = {}): TraceQueryResult {
    const clauses: string[] = []
    const params: Record<string, string | number> = {}
    if (input.taskId !== undefined) {
      clauses.push('task_id = @taskId')
      params.taskId = input.taskId
    }
    if (input.traceId !== undefined) {
      clauses.push('trace_id = @traceId')
      params.traceId = input.traceId
    }
    if (input.errorCode !== undefined) {
      clauses.push('error_code = @errorCode')
      params.errorCode = input.errorCode
    }
    if (input.level !== undefined) {
      clauses.push('level = @level')
      params.level = input.level
    }
    if (input.from !== undefined) {
      clauses.push('ts >= @from')
      params.from = input.from
    }
    if (input.to !== undefined) {
      clauses.push('ts < @to')
      params.to = input.to
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const limit = Math.min(5_000, Math.max(1, Math.trunc(input.limit ?? 100)))
    const counted = db
      .prepare(`SELECT COUNT(*) AS n FROM trace_events ${where}`)
      .get(params) as { n: number }
    const rows = db
      .prepare(`SELECT * FROM trace_events ${where} ORDER BY ts DESC, rowid DESC LIMIT @limit`)
      .all({ ...params, limit }) as TraceRow[]
    return { rows: rows.map(toTraceRecord), count: counted.n }
  }

  function stats(): TelemetryStats {
    const timestamp = now()
    const day = dayKey(timestamp)
    const dropped: Record<string, number> = {}
    const persisted = db
      .prepare('SELECT reason, count FROM telemetry_drops WHERE day = ?')
      .all(day) as Array<{ reason: string; count: number }>
    for (const row of persisted) dropped[row.reason] = row.count
    for (const [reason, aggregate] of pendingDrops) {
      dropped[reason] = (dropped[reason] ?? 0) + aggregate.count
    }
    const today = readUsage(`day:${day}`)
    const total = db.prepare('SELECT COUNT(*) AS n FROM trace_events').get() as { n: number }
    const ratio = readDiskRatio()
    return {
      mode,
      degraded: mode === 'full' && ratio !== null && ratio >= diskWarnRatio,
      diskRatio: ratio,
      queueDepth: queue.length,
      events: total.n,
      todayBytes: today.bytes,
      dropped,
      lastFlushAt,
    }
  }

  function prune(input: { now?: Date } = {}): PruneResult {
    const timestamp = input.now ?? now()
    const cutoff = new Date(timestamp.getTime() - retentionDays * 86_400_000)
    const cutoffIso = cutoff.toISOString()
    const cutoffDay = dayKey(cutoff)
    const fileCutoff = new Date(timestamp.getTime() - fileRetentionDays * 86_400_000)
    const fileCutoffDay = dayKey(fileCutoff)

    const remove = db.transaction((): Omit<PruneResult, 'files'> => {
      const events = db.prepare('DELETE FROM trace_events WHERE ts < ?').run(cutoffIso).changes
      const attempts = db
        .prepare('DELETE FROM task_attempts WHERE COALESCE(finished_at, started_at) < ?')
        .run(cutoffIso).changes
      const usage = db.prepare('DELETE FROM telemetry_usage WHERE updated_at < ?').run(cutoffIso).changes
      const drops = db.prepare('DELETE FROM telemetry_drops WHERE day < ?').run(cutoffDay).changes
      return { events, attempts, usage, drops }
    })
    const counts = remove.immediate()
    usageCache.clear()
    const files = traceDir === null ? 0 : pruneTraceFiles(traceDir, fileCutoffDay)
    return { ...counts, files }
  }

  function close(): void {
    if (closed) return
    clearTimers()
    flushNow()
    closed = true
    db.close()
  }

  return {
    emit,
    flush: async () => flushNow(),
    beginAttempt,
    finishAttempt,
    getAttempt,
    attempts,
    attemptsSince,
    query,
    stats,
    prune,
    close,
  }
}
