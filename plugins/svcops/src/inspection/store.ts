/**
 * `inspections` store — single writer is module ⑦ (docs/15 §三), so it lives
 * inside svcops rather than governance.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import type { InspectionItem, InspectionItemStatus } from './checklist.js'

const MIGRATION_MODULE = 'inspection'
const MIGRATION_VERSION = 1

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module)
);
`

const INSPECTION_DDL = `
CREATE TABLE IF NOT EXISTS inspections (
  id             TEXT PRIMARY KEY,
  checklist_id   TEXT NOT NULL,
  target         TEXT NOT NULL,
  status         TEXT NOT NULL,
  findings_json  TEXT NOT NULL,
  ran_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_inspections_target_time ON inspections(target, ran_at DESC);
`

export interface InspectionRecord {
  id: string
  checklistId: string
  target: string
  status: InspectionItemStatus
  items: InspectionItem[]
  ranAt: string
}

export interface SaveInspectionInput {
  checklistId: string
  target: string
  status: InspectionItemStatus
  items: InspectionItem[]
  ranAt?: string
}

export interface InspectionStore {
  save(input: SaveInspectionInput): InspectionRecord
  latest(target?: string): InspectionRecord | null
  /** Records with `ran_at` in [from, to], oldest first; used by the G3 digest. */
  listSince(from: string, to?: string): InspectionRecord[]
  close(): void
}

interface Row {
  id: string
  checklist_id: string
  target: string
  status: InspectionItemStatus
  findings_json: string
  ran_at: string
}

function toRecord(row: Row): InspectionRecord {
  return {
    id: row.id,
    checklistId: row.checklist_id,
    target: row.target,
    status: row.status,
    items: JSON.parse(row.findings_json) as InspectionItem[],
    ranAt: row.ran_at,
  }
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  if ((row?.version ?? 0) >= MIGRATION_VERSION) return

  db.transaction(() => {
    db.exec(INSPECTION_DDL)
    db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
      MIGRATION_MODULE,
      MIGRATION_VERSION,
      new Date().toISOString(),
    )
  }).immediate()
}

export function createInspectionStore(dbPath: string): InspectionStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const insert = db.prepare(`
    INSERT INTO inspections(id, checklist_id, target, status, findings_json, ran_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const latestAll = db.prepare('SELECT * FROM inspections ORDER BY ran_at DESC, rowid DESC LIMIT 1')
  const latestOf = db.prepare(
    'SELECT * FROM inspections WHERE target = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1',
  )
  const listFrom = db.prepare(
    'SELECT * FROM inspections WHERE ran_at >= ? ORDER BY ran_at ASC, rowid ASC',
  )
  const listWindow = db.prepare(
    'SELECT * FROM inspections WHERE ran_at >= ? AND ran_at <= ? ORDER BY ran_at ASC, rowid ASC',
  )

  return {
    save(input) {
      const record: InspectionRecord = {
        id: randomUUID(),
        checklistId: input.checklistId,
        target: input.target,
        status: input.status,
        items: input.items,
        ranAt: input.ranAt ?? new Date().toISOString(),
      }
      insert.run(
        record.id,
        record.checklistId,
        record.target,
        record.status,
        JSON.stringify(record.items),
        record.ranAt,
      )
      return record
    },
    latest(target) {
      const row = (target === undefined ? latestAll.get() : latestOf.get(target)) as Row | undefined
      return row ? toRecord(row) : null
    },
    listSince(from, to) {
      const rows = (to === undefined ? listFrom.all(from) : listWindow.all(from, to)) as Row[]
      return rows.map(toRecord)
    },
    close() {
      db.close()
    },
  }
}
