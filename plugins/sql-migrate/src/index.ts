/**
 * docs/15 §七 migration runner.
 *
 * Every module keeps its DDL in `<module>/migrations/NNN_<name>.sql`. The
 * applied set lives in the shared `schema_migrations` table:
 *
 *   schema_migrations(module TEXT, version INTEGER, name TEXT, checksum TEXT,
 *                     applied_at TEXT, PRIMARY KEY (module, version))
 *
 * Rules:
 *   - append-only: an applied file is never edited. Its sha256 is recorded and
 *     re-verified on every start; a mismatch refuses to open the store (and
 *     therefore startup, per docs/11 §四).
 *   - per-version rows. Databases written before this runner only kept the
 *     highest version per module; those missing rows are backfilled with the
 *     checksum of the file that produced them instead of being re-executed.
 *   - a file that is missing for an applied version also refuses to start.
 *
 * `name` / `checksum` are nullable on purpose: modules that have not migrated
 * to SQL files yet still write `(module, version, applied_at)` only.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/

/** Minimal structural view of a better-sqlite3 database. */
export interface MigrationStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface MigrationDatabase {
  exec(sql: string): unknown
  prepare(sql: string): MigrationStatement
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface MigrationFile {
  version: number
  /** File name including the `.sql` suffix, recorded for traceability. */
  name: string
  path: string
  sql: string
  checksum: string
}

export interface RunMigrationsOptions {
  module: string
  dir: string
  /** Optional pre-checks — a throw refuses the migration (documented exception to "pure SQL"). */
  guards?: Readonly<Record<number, (db: MigrationDatabase) => void>>
  now?: () => Date
}

export interface MigrateResult {
  applied: number[]
  verified: number
  backfilled: number
}

interface AppliedRow {
  version: number
  name: string | null
  checksum: string | null
  applied_at: string
}

const CANONICAL_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module     TEXT NOT NULL,
  version    INTEGER NOT NULL,
  name       TEXT,
  checksum   TEXT,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (module, version)
);
`

const COMPOSITE_KEY = /PRIMARY\s+KEY\s*\(\s*(?:module\s*,\s*version|version\s*,\s*module)\s*\)/i

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function inTransaction<T>(db: MigrationDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already be gone (e.g. SQLite aborted it).
    }
    throw error
  }
}

/** Load `<NNN>_<name>.sql`, requiring a contiguous 1..N sequence. */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  const names = readdirSync(dir).filter((name) => FILE_NAME.test(name)).sort()
  if (names.length === 0) {
    throw new MigrationError(`no migrations found in ${dir}`)
  }
  const files = names.map((name) => {
    const version = Number(FILE_NAME.exec(name)?.[1])
    const path = join(dir, name)
    const sql = readFileSync(path, 'utf8')
    return { version, name, path, sql, checksum: sha256(sql) }
  })
  files.sort((left, right) => left.version - right.version)
  files.forEach((file, index) => {
    const expected = index + 1
    if (file.version !== expected) {
      throw new MigrationError(
        `${dir}: expected version ${expected}, found ${file.name} (migrations must be contiguous from 001)`,
      )
    }
  })
  return files
}

function tableExists(db: MigrationDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined
  return row?.name === 'schema_migrations'
}

function tableSql(db: MigrationDatabase): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { sql?: string } | undefined
  return row?.sql ?? ''
}

function columns(db: MigrationDatabase): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info('schema_migrations')").all() as {
    name: string
  }[]
  return rows.map((row) => row.name)
}

/**
 * Bring `schema_migrations` to the canonical shape, preserving existing rows.
 * Older modules created it with `PRIMARY KEY (module)`; SQLite cannot alter a
 * primary key, so that one case is rebuilt.
 */
function ensureSchemaMigrations(db: MigrationDatabase): void {
  if (!tableExists(db)) {
    db.exec(CANONICAL_DDL)
    return
  }
  if (!COMPOSITE_KEY.test(tableSql(db))) {
    rebuildLegacyTable(db)
  }
  const present = new Set(columns(db))
  if (!present.has('name')) db.exec('ALTER TABLE schema_migrations ADD COLUMN name TEXT')
  if (!present.has('checksum')) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT')
}

function rebuildLegacyTable(db: MigrationDatabase): void {
  const rows = db.prepare('SELECT * FROM schema_migrations').all() as Record<string, unknown>[]
  inTransaction(db, () => {
    db.exec('ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy')
    db.exec(CANONICAL_DDL)
    const insert = db.prepare(
      'INSERT INTO schema_migrations(module, version, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const row of rows) {
      insert.run(
        String(row.module),
        Number(row.version),
        row.name === undefined ? null : row.name,
        row.checksum === undefined ? null : row.checksum,
        String(row.applied_at),
      )
    }
    db.exec('DROP TABLE schema_migrations_legacy')
  })
}

function readApplied(db: MigrationDatabase, module: string): AppliedRow[] {
  const rows = db
    .prepare(
      'SELECT version, name, checksum, applied_at FROM schema_migrations WHERE module = ? ORDER BY version',
    )
    .all(module) as AppliedRow[]
  return rows.map((row) => ({ ...row, version: Number(row.version) }))
}

export function runMigrations(db: MigrationDatabase, options: RunMigrationsOptions): MigrateResult {
  const { module, dir, guards = {} } = options
  const stamp = () => (options.now?.() ?? new Date()).toISOString()
  const files = loadMigrationFiles(dir)

  ensureSchemaMigrations(db)
  const appliedRows = readApplied(db, module)
  const applied = new Map(appliedRows.map((row) => [row.version, row]))
  const byVersion = new Map(files.map((file) => [file.version, file]))

  for (const row of appliedRows) {
    if (!byVersion.has(row.version)) {
      throw new MigrationError(
        `migration ${module} v${row.version}: applied in the database but ${dir} has no matching file`,
      )
    }
  }

  const maxApplied = appliedRows.reduce((max, row) => Math.max(max, row.version), 0)
  const maxAppliedAt = applied.get(maxApplied)?.applied_at ?? stamp()
  const result: MigrateResult = { applied: [], verified: 0, backfilled: 0 }

  for (const file of files) {
    if (file.version > maxApplied) {
      const guard = guards[file.version]
      inTransaction(db, () => {
        guard?.(db)
        db.exec(file.sql)
        db.prepare(
          'INSERT INTO schema_migrations(module, version, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        ).run(module, file.version, file.name, file.checksum, stamp())
      })
      result.applied.push(file.version)
      continue
    }

    const row = applied.get(file.version)
    if (row?.checksum == null) {
      // Legacy row (no checksum) or a version collapsed by the old max-only
      // writer: record what the file hashes to without re-running its DDL.
      if (row === undefined) {
        db.prepare(
          'INSERT INTO schema_migrations(module, version, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)',
        ).run(module, file.version, file.name, file.checksum, maxAppliedAt)
      } else {
        db.prepare(
          'UPDATE schema_migrations SET name = ?, checksum = ? WHERE module = ? AND version = ?',
        ).run(file.name, file.checksum, module, file.version)
      }
      result.backfilled += 1
      continue
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationError(
        `migration ${module} v${file.version}: ${file.name} was modified after it was applied ` +
          `(recorded ${row.checksum}, file ${file.checksum}); migrations are append-only`,
      )
    }
    result.verified += 1
  }

  return result
}
