/**
 * `inspections` store — single writer is module ⑦ (docs/15 §三), so it lives
 * inside svcops rather than governance.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { runMigrations } from '@dsh-wfxm/sql-migrate'
import { CANDIDATE_RULES, type CandidateInput } from './candidates.js'
import type { InspectionItem, InspectionItemStatus } from './checklist.js'

const MIGRATION_MODULE = 'inspection'
/** docs/15 §七: SQL files sit next to the package, outside the compiled `lib/`. */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

export type CandidateStatus = 'open' | 'resolved'

export interface CandidateDigestItem {
  ruleId: string
  title: string
  lastObserved: string
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
}

export interface CandidateDigest {
  /** Rows whose `first_seen_at` falls in the window. */
  opened: number
  /** Rows resolved inside the window. */
  resolved: number
  /** Rows currently `open`, regardless of when they were first seen. */
  stillOpen: number
  /** Currently open candidates, newest first. */
  open: CandidateDigestItem[]
}

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
  /** Upserts one row per `(rule_id, item_id, target)`; reopens resolved rows. */
  recordCandidates(inputs: CandidateInput[], at: Date): number
  /** Marks this target's open candidates that are absent from `nowOpen` as resolved. */
  resolveCandidates(nowOpen: CandidateInput[], target: string, at: Date): number
  /** B2 v1 observe counters for the daily digest. */
  candidateDigest(sinceIso: string): CandidateDigest
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

interface CandidateRow {
  rule_id: string
  item_id: string
  title: string
  target: string
  status: CandidateStatus
  last_observed: string
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  seen_count: number
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
  runMigrations(db, { module: MIGRATION_MODULE, dir: MIGRATIONS_DIR })
}

function candidateTitle(input: CandidateInput): string {
  return CANDIDATE_RULES[input.itemId]?.title ?? input.itemId
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
  const upsertCandidate = db.prepare(`
    INSERT INTO inspection_candidates(
      id, rule_id, item_id, title, target, status, last_observed,
      first_seen_at, last_seen_at, resolved_at, seen_count
    )
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, 1)
    ON CONFLICT(rule_id, item_id, target) DO UPDATE SET
      title = excluded.title,
      status = 'open',
      last_observed = excluded.last_observed,
      last_seen_at = excluded.last_seen_at,
      resolved_at = NULL,
      seen_count = inspection_candidates.seen_count + 1
  `)
  const listOpenForTarget = db.prepare(
    "SELECT rule_id, item_id FROM inspection_candidates WHERE target = ? AND status = 'open'",
  )
  const resolveOne = db.prepare(
    "UPDATE inspection_candidates SET status = 'resolved', resolved_at = ? WHERE target = ? AND rule_id = ? AND item_id = ?",
  )
  const countOpened = db.prepare(
    'SELECT COUNT(*) AS n FROM inspection_candidates WHERE first_seen_at >= ?',
  )
  const countResolved = db.prepare(
    "SELECT COUNT(*) AS n FROM inspection_candidates WHERE status = 'resolved' AND resolved_at >= ?",
  )
  const countOpen = db.prepare(
    "SELECT COUNT(*) AS n FROM inspection_candidates WHERE status = 'open'",
  )
  const listOpen = db.prepare(
    "SELECT * FROM inspection_candidates WHERE status = 'open' ORDER BY last_seen_at DESC, rowid DESC",
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
    recordCandidates(inputs, at) {
      const iso = at.toISOString()
      const run = db.transaction((items: CandidateInput[]) => {
        for (const input of items) {
          upsertCandidate.run(
            randomUUID(),
            input.ruleId,
            input.itemId,
            candidateTitle(input),
            input.target,
            input.observed,
            iso,
            iso,
          )
        }
      })
      run.immediate(inputs)
      return inputs.length
    },
    resolveCandidates(nowOpen, target, at) {
      const active = new Set<string>()
      for (const input of nowOpen) {
        if (input.target !== target) continue
        active.add(`${input.ruleId}\u0000${input.itemId}`)
      }
      const rows = listOpenForTarget.all(target) as Array<{ rule_id: string; item_id: string }>
      let resolved = 0
      const run = db.transaction(() => {
        for (const row of rows) {
          if (active.has(`${row.rule_id}\u0000${row.item_id}`)) continue
          resolved += resolveOne.run(at.toISOString(), target, row.rule_id, row.item_id).changes
        }
      })
      run.immediate()
      return resolved
    },
    candidateDigest(sinceIso) {
      const opened = (countOpened.get(sinceIso) as { n: number }).n
      const resolved = (countResolved.get(sinceIso) as { n: number }).n
      const stillOpen = (countOpen.get() as { n: number }).n
      const rows = listOpen.all() as CandidateRow[]
      return {
        opened,
        resolved,
        stillOpen,
        open: rows.map((row) => ({
          ruleId: row.rule_id,
          title: row.title,
          lastObserved: row.last_observed,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          seenCount: row.seen_count,
        })),
      }
    },
    close() {
      db.close()
    },
  }
}
