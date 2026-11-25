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
import { dirname } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'

import { digestText } from './digest.js'

const MIGRATION_MODULE = 'eval'

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const RUNS_DDL = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id              TEXT PRIMARY KEY,
  suite           TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('l2','snapshot')),
  status          TEXT NOT NULL CHECK (status IN ('running','ok','failed','timeout')),
  passed          INTEGER,
  total           INTEGER,
  advisory        INTEGER NOT NULL DEFAULT 1,
  report_ref      TEXT,
  triggered_by    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_eval_runs_started ON eval_runs(started_at DESC);
`

const FINDINGS_DDL = `
CREATE TABLE IF NOT EXISTS eval_findings (
  id               TEXT PRIMARY KEY,
  run_id           TEXT,
  suite            TEXT NOT NULL DEFAULT '',
  task_id          TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL CHECK (severity IN ('fail','warn')),
  title            TEXT NOT NULL,
  detail_digest    TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('ci','flag')),
  status           TEXT NOT NULL CHECK (status IN ('open','promoted','ignored')),
  promoted_task_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_eval_findings_key
  ON eval_findings(run_id, suite, task_id);
CREATE INDEX IF NOT EXISTS ix_eval_findings_status
  ON eval_findings(status, created_at);
`

/** P2-3 才会写入；先建表保证 module 版本一次到位。 */
const FLAGS_DDL = `
CREATE TABLE IF NOT EXISTS eval_flags (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  thread_id     TEXT,
  verdict       TEXT NOT NULL,
  reason_digest TEXT NOT NULL,
  trace_ref     TEXT,
  created_at    TEXT NOT NULL
);
`

interface Migration {
  version: number
  ddl: string[]
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, ddl: [RUNS_DDL, FINDINGS_DDL, FLAGS_DDL] },
]

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
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  const current = row?.version ?? 0
  const pending = MIGRATIONS.filter((migration) => migration.version > current)
  if (pending.length === 0) return

  db.transaction(() => {
    for (const migration of pending) for (const ddl of migration.ddl) db.exec(ddl)
    const latest = pending[pending.length - 1].version
    if (current === 0) {
      db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
        MIGRATION_MODULE,
        latest,
        new Date().toISOString(),
      )
    } else {
      db.prepare('UPDATE schema_migrations SET version = ?, applied_at = ? WHERE module = ?').run(
        latest,
        new Date().toISOString(),
        MIGRATION_MODULE,
      )
    }
  }).immediate()
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
    syncSnapshot,
    close: () => db.close(),
  }
}
