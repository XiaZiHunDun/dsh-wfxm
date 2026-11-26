import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '@dsh-wfxm/sql-migrate'
import { uuidv7 } from '../audit/store.js'

const MIGRATION_MODULE = 'policy'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'policy')

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
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
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
