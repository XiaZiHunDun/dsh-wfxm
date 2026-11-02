import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { uuidv7 } from '../audit/store.js'

const MIGRATION_MODULE = 'policy'
const MIGRATION_VERSION = 1

const DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  correlation_id  TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('S1','S2','jev','fallback')),
  rule_id         TEXT,
  ruleset_version TEXT,
  input_digest    TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  confidence      REAL,
  reason          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_corr ON decisions(correlation_id);
`

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module, version)
);
`

export interface DecisionRecord {
  correlationId: string
  ruleId: string
  rulesetVersion: string
  inputDigest: string
  verdict: string
  reason?: string
}

export interface DecisionStore {
  record(entry: DecisionRecord): void
  close(): void
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  if ((row?.version ?? 0) >= MIGRATION_VERSION) return

  const apply = db.transaction(() => {
    db.exec(DECISIONS_DDL)
    db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
      MIGRATION_MODULE,
      MIGRATION_VERSION,
      new Date().toISOString(),
    )
  })
  apply.immediate()
}

export function createDecisionStore(dbPath: string): DecisionStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insert = db.prepare(`
    INSERT INTO decisions
      (id, correlation_id, stage, rule_id, ruleset_version, input_digest, verdict, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    record: (entry) => {
      insert.run(
        uuidv7(),
        entry.correlationId,
        'S1',
        entry.ruleId,
        entry.rulesetVersion,
        entry.inputDigest,
        entry.verdict,
        entry.reason ?? null,
        new Date().toISOString(),
      )
    },
    close: () => db.close(),
  }
}
