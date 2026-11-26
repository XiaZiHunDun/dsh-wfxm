/**
 * `eval_runs` / `eval_findings` / `eval_flags` store（module `eval`）。
 *
 * 单一写者：本模块（docs/15 §三）。三张表都进同一个 `ops.sqlite`，用
 * `schema_migrations(module='eval')` 与其它模块隔离。
 *
 * - run 以 `idempotency_key` 幂等：重复请求返回同一行，不重跑；
 * - 状态机只允许 `running → ok|failed|timeout`，终态不会被后来的写入覆盖；
 * - finding 以 `(run_id, suite, task_id)` 幂等，只存脱敏截断摘要；
 * - 报告本身不进库，`report_ref` 指向 `.eval-runs/` 或 `eval/latest.json`。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { runMigrations } from '@dsh-wfxm/sql-migrate'

import { digestText } from './digest.js'

const MIGRATION_MODULE = 'eval'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export type EvalRunStatus = 'running' | 'ok' | 'failed' | 'timeout'
export type EvalRunMode = 'l2' | 'snapshot'
export type EvalFindingStatus = 'open' | 'promoted' | 'ignored'
export type EvalFindingSource = 'ci' | 'flag'

export interface EvalRun {
  id: string
  suite: string
  runtime: string
  mode: EvalRunMode
  status: EvalRunStatus
  passed: number | null
  total: number | null
  advisory: boolean
  reportRef: string | null
  triggeredBy: string | null
  idempotencyKey: string
  startedAt: string
  finishedAt: string | null
}

export interface EvalFinding {
  id: string
  runId: string | null
  suite: string
  taskId: string
  severity: 'fail' | 'warn'
  title: string
  detailDigest: string
  source: EvalFindingSource
  status: EvalFindingStatus
  promotedTaskId: string | null
  createdAt: string
}

export interface RecordRunInput {
  suite: string
  runtime?: string
  mode: EvalRunMode
  /** 默认 `running`；快照同步可一次写成终态。 */
  status?: EvalRunStatus
  passed?: number | null
  total?: number | null
  advisory?: boolean
  reportRef?: string | null
  triggeredBy?: string | null
  idempotencyKey: string
  startedAt?: string
  finishedAt?: string | null
}

export interface FinishRunInput {
  status: Exclude<EvalRunStatus, 'running'>
  passed?: number | null
  total?: number | null
  advisory?: boolean
  reportRef?: string | null
  finishedAt?: string
}

export interface FindingInput {
  suite: string
  taskId?: string | null
  severity?: 'fail' | 'warn'
  title: string
  detail?: string | null
  source?: EvalFindingSource
}

export interface ListFindingsOptions {
  status?: EvalFindingStatus
  /** 只查某一次 run 的 findings（可追溯）。 */
  runId?: string
  limit?: number
}

export interface FlagInput {
  /** 被引用的消息 id；找不到引用时由宿主拒绝。 */
  messageId: string
  threadId?: string | null
  reason: string
  verdict?: string
  traceRef?: string | null
}

/** P7-1: 把一条生产失败任务登记成 finding（同一任务只登记一次）。 */
export interface ProductionFindingInput {
  /** 默认 `production`。 */
  suite?: string
  taskId: string
  title: string
  detail?: string | null
}

export interface EvalFlag {
  id: string
  messageId: string
  threadId: string | null
  verdict: string
  reasonDigest: string
  traceRef: string | null
  createdAt: string
}

export type FindingResolution =
  | { finding: EvalFinding }
  | { error: 'not-found' | 'ambiguous' }

export interface EvalStore {
  recordRun(input: RecordRunInput): { run: EvalRun; created: boolean }
  finishRun(id: string, input: FinishRunInput): EvalRun | null
  getRun(id: string): EvalRun | null
  findRunByIdempotencyKey(key: string): EvalRun | null
  /** 当前仍在执行的 run；用于阻止并发重跑。 */
  findRunningRun(): EvalRun | null
  listRuns(options?: { limit?: number }): EvalRun[]
  upsertFindings(runId: string, items: readonly FindingInput[]): number
  listFindings(options?: ListFindingsOptions): EvalFinding[]
  listOpenFindings(limit?: number): EvalFinding[]
  /** P2-3: 人工标记 → eval_flags + 一条 source=flag 的 finding。 */
  recordFlag(input: FlagInput): { finding: EvalFinding; flag: EvalFlag }
  /** P7-1: 生产失败 → 一条 source=ci 的 finding；同 suite+task 只登记一次。 */
  recordProductionFinding(input: ProductionFindingInput): { finding: EvalFinding; created: boolean }
  /** 按完整 id 或唯一前缀找 finding。 */
  resolveFinding(ref: string): FindingResolution
  setFindingStatus(id: string, status: EvalFindingStatus, promotedTaskId?: string | null): EvalFinding | null
  syncSnapshot(snapshot: SnapshotLike): { run: EvalRun; created: boolean; findings: number }
  close(): void
}

/** 只取 `/eval` 快照用到的字段，避免本包反向依赖 host。 */
export interface SnapshotLike {
  recordedAt: string
  source?: string
  advisory?: boolean
  gate?: {
    ok?: boolean
    advisory?: boolean
    suites?: Array<{ name: string; passed: number; total: number; rate?: number }>
  } | null
  real?: Record<string, {
    passed: number
    total: number
    rate?: number
    failures?: Array<{ taskId: string; rate?: number }>
  }> | null
  failures?: Array<{ suite: string; taskId?: string; rate?: number }>
}

interface RunRow {
  id: string
  suite: string
  runtime: string
  mode: EvalRunMode
  status: EvalRunStatus
  passed: number | null
  total: number | null
  advisory: number
  report_ref: string | null
  triggered_by: string | null
  idempotency_key: string
  started_at: string
  finished_at: string | null
}

interface FindingRow {
  id: string
  run_id: string | null
  suite: string
  task_id: string
  severity: 'fail' | 'warn'
  title: string
  detail_digest: string
  source: EvalFindingSource
  status: EvalFindingStatus
  promoted_task_id: string | null
  created_at: string
}

function toRun(row: RunRow): EvalRun {
  return {
    id: row.id,
    suite: row.suite,
    runtime: row.runtime,
    mode: row.mode,
    status: row.status,
    passed: row.passed,
    total: row.total,
    advisory: row.advisory !== 0,
    reportRef: row.report_ref,
    triggeredBy: row.triggered_by,
    idempotencyKey: row.idempotency_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function toFinding(row: FindingRow): EvalFinding {
  return {
    id: row.id,
    runId: row.run_id,
    suite: row.suite,
    taskId: row.task_id,
    severity: row.severity,
    title: row.title,
    detailDigest: row.detail_digest,
    source: row.source,
    status: row.status,
    promotedTaskId: row.promoted_task_id,
    createdAt: row.created_at,
  }
}

function migrate(db: Database): void {
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

export function createEvalStore(dbPath: string): EvalStore {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  // 进程在 run 期间崩溃：超过执行上限的 running 行标记 timeout，避免永久挡住下一次执行。
  db.prepare("UPDATE eval_runs SET status = 'timeout', finished_at = ? WHERE status = 'running' AND started_at < ?").run(
    new Date().toISOString(),
    new Date(Date.now() - 15 * 60_000).toISOString(),
  )

  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO eval_runs(
      id, suite, runtime, mode, status, passed, total, advisory, report_ref,
      triggered_by, idempotency_key, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const selectRunById = db.prepare('SELECT * FROM eval_runs WHERE id = ?')
  const selectRunByKey = db.prepare('SELECT * FROM eval_runs WHERE idempotency_key = ?')
  const selectRunning = db.prepare("SELECT * FROM eval_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
  const selectRuns = db.prepare('SELECT * FROM eval_runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
  const finishRunStmt = db.prepare(`
    UPDATE eval_runs
       SET status = ?, passed = ?, total = ?, advisory = ?, report_ref = ?, finished_at = ?
     WHERE id = ? AND status = 'running'
  `)
  const insertFinding = db.prepare(`
    INSERT INTO eval_findings(
      id, run_id, suite, task_id, severity, title, detail_digest,
      source, status, promoted_task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)
    ON CONFLICT(run_id, suite, task_id) DO UPDATE SET
      title = excluded.title,
      detail_digest = excluded.detail_digest
  `)
  const selectFindings = db.prepare(`
    SELECT * FROM eval_findings
     WHERE (? IS NULL OR status = ?)
       AND (? IS NULL OR run_id = ?)
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?
  `)
  const selectFindingById = db.prepare('SELECT * FROM eval_findings WHERE id = ?')
  const selectFindingByPrefix = db.prepare('SELECT * FROM eval_findings WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2')
  const updateFindingStatus = db.prepare('UPDATE eval_findings SET status = ?, promoted_task_id = ? WHERE id = ?')
  const insertFlag = db.prepare(`
    INSERT INTO eval_flags(id, message_id, thread_id, verdict, reason_digest, trace_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const selectProductionFinding = db.prepare(`
    SELECT * FROM eval_findings
     WHERE run_id IS NULL AND suite = ? AND task_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `)
  const insertProductionFinding = db.prepare(`
    INSERT INTO eval_findings(
      id, run_id, suite, task_id, severity, title, detail_digest,
      source, status, promoted_task_id, created_at
    ) VALUES (?, NULL, ?, ?, 'fail', ?, ?, 'ci', 'open', NULL, ?)
  `)

  function getRun(id: string): EvalRun | null {
    const row = selectRunById.get(id) as RunRow | undefined
    return row === undefined ? null : toRun(row)
  }

  function findRunByIdempotencyKey(key: string): EvalRun | null {
    const row = selectRunByKey.get(key) as RunRow | undefined
    return row === undefined ? null : toRun(row)
  }

  function findRunningRun(): EvalRun | null {
    const row = selectRunning.get() as RunRow | undefined
    return row === undefined ? null : toRun(row)
  }

  function recordRun(input: RecordRunInput): { run: EvalRun; created: boolean } {
    const existing = findRunByIdempotencyKey(input.idempotencyKey)
    if (existing !== null) return { run: existing, created: false }

    const id = randomUUID()
    const startedAt = input.startedAt ?? new Date().toISOString()
    const status = input.status ?? 'running'
    const info = insertRun.run(
      id,
      input.suite,
      input.runtime ?? 'dsh-wfxm',
      input.mode,
      status,
      input.passed ?? null,
      input.total ?? null,
      input.advisory === false ? 0 : 1,
      input.reportRef ?? null,
      input.triggeredBy ?? null,
      input.idempotencyKey,
      startedAt,
      status === 'running' ? null : input.finishedAt ?? startedAt,
    )
    if (info.changes === 0) {
      // 并发下另一条写入赢了：返回它，保证调用方看到同一个 run。
      const raced = findRunByIdempotencyKey(input.idempotencyKey)
      if (raced !== null) return { run: raced, created: false }
    }
    const run = getRun(id)
    if (run === null) throw new Error(`eval run ${id} vanished after insert`)
    return { run, created: info.changes > 0 }
  }

  function finishRun(id: string, input: FinishRunInput): EvalRun | null {
    const current = getRun(id)
    if (current === null) return null
    // 终态保护：already ok/failed/timeout 不再被覆盖。
    if (current.status !== 'running') return current
    finishRunStmt.run(
      input.status,
      input.passed === undefined ? current.passed : input.passed,
      input.total === undefined ? current.total : input.total,
      (input.advisory ?? current.advisory) ? 1 : 0,
      input.reportRef === undefined ? current.reportRef : input.reportRef,
      input.finishedAt ?? new Date().toISOString(),
      id,
    )
    return getRun(id)
  }

  function listRuns(options: { limit?: number } = {}): EvalRun[] {
    return (selectRuns.all(options.limit ?? 20) as RunRow[]).map(toRun)
  }

  function upsertFindings(runId: string, items: readonly FindingInput[]): number {
    if (items.length === 0) return 0
    const createdAt = new Date().toISOString()
    // 同批次同 key 只写一次；ON CONFLICT 兜住跨批次重复。
    const seen = new Set<string>()
    let written = 0
    db.transaction(() => {
      for (const item of items) {
        const taskId = item.taskId ?? ''
        const key = `${item.suite}:${taskId}`
        if (seen.has(key)) continue
        seen.add(key)
        const detail = item.detail === undefined || item.detail === null || item.detail === ''
          ? digestText(item.title)
          : digestText(item.detail)
        insertFinding.run(
          randomUUID(),
          runId,
          item.suite,
          taskId,
          item.severity ?? 'fail',
          item.title,
          detail,
          item.source ?? 'ci',
          createdAt,
        )
        written += 1
      }
    }).immediate()
    return written
  }

  function listFindings(options: ListFindingsOptions = {}): EvalFinding[] {
    const status = options.status ?? null
    const runId = options.runId ?? null
    return (selectFindings.all(status, status, runId, runId, options.limit ?? 50) as FindingRow[]).map(toFinding)
  }

  function listOpenFindings(limit = 20): EvalFinding[] {
    return listFindings({ status: 'open', limit })
  }

  function resolveFinding(ref: string): FindingResolution {
    const needle = ref.trim().replace(/^#/, '')
    if (needle === '') return { error: 'not-found' }
    const exact = selectFindingById.get(needle) as FindingRow | undefined
    if (exact !== undefined) return { finding: toFinding(exact) }
    const rows = selectFindingByPrefix.all(`${needle}%`) as FindingRow[]
    if (rows.length === 0) return { error: 'not-found' }
    if (rows.length > 1) return { error: 'ambiguous' }
    return { finding: toFinding(rows[0]) }
  }

  function setFindingStatus(
    id: string,
    status: EvalFindingStatus,
    promotedTaskId?: string | null,
  ): EvalFinding | null {
    updateFindingStatus.run(status, promotedTaskId ?? null, id)
    const row = selectFindingById.get(id) as FindingRow | undefined
    return row === undefined ? null : toFinding(row)
  }

  function recordFlag(input: FlagInput): { finding: EvalFinding; flag: EvalFlag } {
    const createdAt = new Date().toISOString()
    const verdict = input.verdict ?? 'negative'
    const reasonDigest = digestText(input.reason)
    // 标题也只取脱敏摘要，避免把原话/密钥写进库。
    const summary = reasonDigest.replace(/^sha256:[0-9a-f]+\s*/, '').trim()
    const flagId = randomUUID()
    db.transaction(() => {
      insertFlag.run(
        flagId,
        input.messageId,
        input.threadId ?? null,
        verdict,
        reasonDigest,
        input.traceRef ?? null,
        createdAt,
      )
      insertFinding.run(
        randomUUID(),
        null,
        'flag',
        '',
        'warn',
        summary === '' ? '人工标记' : `人工标记：${summary}`,
        reasonDigest,
        'flag',
        createdAt,
      )
    }).immediate()

    // 刚插入的那条想到即可：按创建时间取最新 flag finding。
    const row = db.prepare("SELECT * FROM eval_findings WHERE source = 'flag' ORDER BY rowid DESC LIMIT 1").get() as FindingRow
    return {
      finding: toFinding(row),
      flag: {
        id: flagId,
        messageId: input.messageId,
        threadId: input.threadId ?? null,
        verdict,
        reasonDigest,
        traceRef: input.traceRef ?? null,
        createdAt,
      },
    }
  }

  function recordProductionFinding(input: ProductionFindingInput): { finding: EvalFinding; created: boolean } {
    const suite = input.suite ?? 'production'
    const existing = selectProductionFinding.get(suite, input.taskId) as FindingRow | undefined
    if (existing !== undefined) return { finding: toFinding(existing), created: false }
    const createdAt = new Date().toISOString()
    const detail = input.detail === undefined || input.detail === null || input.detail === ''
      ? digestText(input.title)
      : digestText(input.detail)
    const id = randomUUID()
    insertProductionFinding.run(id, suite, input.taskId, input.title, detail, createdAt)
    const row = selectFindingById.get(id) as FindingRow | undefined
    if (row === undefined) throw new Error(`eval finding ${id} vanished after insert`)
    return { finding: toFinding(row), created: true }
  }

  function syncSnapshot(snapshot: SnapshotLike): { run: EvalRun; created: boolean; findings: number } {
    const failures = snapshot.failures ?? []
    let passed = 0
    let total = 0
    for (const suite of snapshot.gate?.suites ?? []) {
      passed += suite.passed
      total += suite.total
    }
    for (const suite of Object.values(snapshot.real ?? {})) {
      passed += suite.passed
      total += suite.total
    }

    const advisory = snapshot.advisory === true || snapshot.gate?.advisory === true
    const { run, created } = recordRun({
      suite: 'snapshot',
      runtime: 'dsh-wfxm',
      mode: 'snapshot',
      status: failures.length > 0 ? 'failed' : 'ok',
      passed,
      total,
      advisory,
      reportRef: 'eval/latest.json',
      triggeredBy: snapshot.source ?? 'snapshot',
      idempotencyKey: `snapshot:${snapshot.recordedAt}`,
      startedAt: snapshot.recordedAt,
      finishedAt: snapshot.recordedAt,
    })

    const findings = upsertFindings(run.id, failures.map((item) => ({
      suite: item.suite,
      taskId: item.taskId ?? null,
      severity: 'fail' as const,
      title: item.taskId ?? `${item.suite}（套件未全过）`,
      detail: typeof item.rate === 'number' ? `通过率 ${Math.round(item.rate * 100)}%` : null,
      source: 'ci' as const,
    })))
    return { run, created, findings }
  }

  return {
    recordRun,
    finishRun,
    getRun,
    findRunByIdempotencyKey,
    findRunningRun,
    listRuns,
    upsertFindings,
    listFindings,
    listOpenFindings,
    recordFlag,
    recordProductionFinding,
    resolveFinding,
    setFindingStatus,
    syncSnapshot,
    close: () => db.close(),
  }
}
