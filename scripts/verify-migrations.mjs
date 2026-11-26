#!/usr/bin/env node
/**
 * N8 (docs/15 §七): contract versioning gate.
 *
 * Proves the shared runner's contract without touching a live database:
 *   - migrations live in `<module>/migrations/NNN_<name>.sql`, contiguous 1..N;
 *   - every applied version keeps its sha256, and editing it refuses to start;
 *   - a removed file for an applied version refuses to start;
 *   - legacy shapes (PRIMARY KEY(module), collapsing rows, no checksum column)
 *     are normalised and backfilled instead of re-executed;
 *   - tasks/gateway stores no longer carry inline migration arrays.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../plugins/tasks/package.json', import.meta.url))
const DatabaseConstructor = require('better-sqlite3')
const { MigrationError, loadMigrationFiles, runMigrations } = await import(
  '../plugins/sql-migrate/lib/index.js'
)
const { createTaskStore } = await import('../plugins/tasks/lib/index.js')
const { createGatewayStore } = await import('../plugins/gateway/lib/index.js')

const root = fileURLToPath(new URL('..', import.meta.url))
const TASKS_DIR = join(root, 'plugins/tasks/migrations')
const GATEWAY_DIR = join(root, 'plugins/gateway/migrations')
const work = mkdtempSync(join(tmpdir(), 'dsh-migrations-'))

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    if (fn() === false) throw new Error('returned false')
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function copyMigrations(source, name) {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(source)) copyFileSync(join(source, file), join(dir, file))
  return dir
}

function rowsOf(dbPath, module) {
  const db = new DatabaseConstructor(dbPath, { readonly: true })
  const rows = db
    .prepare(
      'SELECT version, name, checksum, applied_at FROM schema_migrations WHERE module = ? ORDER BY version',
    )
    .all(module)
  db.close()
  return rows
}

function versions(count) {
  return Array.from({ length: count }, (_, index) => index + 1)
}

check('tasks ships 15 SQL migrations, one checksummed row per version', () => {
  const path = join(work, 'tasks.sqlite')
  createTaskStore(path).close()
  const rows = rowsOf(path, 'tasks')
  const files = loadMigrationFiles(TASKS_DIR)
  assert.deepEqual(rows.map((row) => row.version), versions(15))
  assert.deepEqual(rows.map((row) => row.name), files.map((file) => file.name))
  assert.deepEqual(rows.map((row) => row.checksum), files.map((file) => file.checksum))
  return rows.at(-1).name === '015_expert.sql'
})

check('gateway ships 9 SQL migrations, one checksummed row per version', () => {
  const path = join(work, 'gateway.sqlite')
  createGatewayStore(path).close()
  const rows = rowsOf(path, 'gateway')
  assert.deepEqual(rows.map((row) => row.version), versions(9))
  assert.equal(rows.at(-1).name, '009_pairing_codes.sql')
  return rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))
})

check('reopening verifies all applied files and writes nothing new', () => {
  const path = join(work, 'reopen.sqlite')
  createGatewayStore(path).close()
  const before = rowsOf(path, 'gateway')
  createGatewayStore(path).close()
  const after = rowsOf(path, 'gateway')
  assert.deepEqual(after, before)
  return true
})

check('runMigrations reports applied once, then verified on the next open', () => {
  const path = join(work, 'counts.sqlite')
  const db = new DatabaseConstructor(path)
  const first = runMigrations(db, { module: 'tasks', dir: TASKS_DIR })
  const second = runMigrations(db, { module: 'tasks', dir: TASKS_DIR })
  db.close()
  return first.applied.length === 15
    && first.verified === 0
    && second.applied.length === 0
    && second.verified === 15
})

check('editing an applied SQL file refuses to start', () => {
  const dir = copyMigrations(TASKS_DIR, 'tampered')
  const path = join(work, 'tampered.sqlite')
  const db = new DatabaseConstructor(path)
  runMigrations(db, { module: 'tasks', dir })
  db.close()
  const file = join(dir, '002_threads.sql')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- drift\n`)
  const reopened = new DatabaseConstructor(path)
  try {
    assert.throws(
      () => runMigrations(reopened, { module: 'tasks', dir }),
      (error) =>
        error instanceof MigrationError && /modified after it was applied/.test(error.message),
    )
  } finally {
    reopened.close()
  }
  return true
})

check('a missing file for an applied version refuses to start', () => {
  const dir = copyMigrations(TASKS_DIR, 'missing')
  const path = join(work, 'missing.sqlite')
  const db = new DatabaseConstructor(path)
  runMigrations(db, { module: 'tasks', dir })
  db.close()
  // Remove the newest file: the remaining 1..14 stay contiguous, so the
  // failure has to come from "applied version 15 has no file".
  rmSync(join(dir, '015_expert.sql'))
  const reopened = new DatabaseConstructor(path)
  try {
    assert.throws(
      () => runMigrations(reopened, { module: 'tasks', dir }),
      (error) => error instanceof MigrationError && /no matching file/.test(error.message),
    )
  } finally {
    reopened.close()
  }
  return true
})

check('a non-contiguous file set is rejected before any DDL runs', () => {
  const dir = join(work, 'gap')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE demo_one (id TEXT PRIMARY KEY);\n')
  writeFileSync(join(dir, '003_skip.sql'), 'CREATE TABLE demo_three (id TEXT PRIMARY KEY);\n')
  assert.throws(
    () => loadMigrationFiles(dir),
    (error) => error instanceof MigrationError && /expected version 2/.test(error.message),
  )
  return true
})

check('a legacy PRIMARY KEY(module) table is rebuilt without losing rows', () => {
  const dir = join(work, 'legacy-key')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE demo_one (id TEXT PRIMARY KEY);\n')
  writeFileSync(join(dir, '002_more.sql'), 'CREATE TABLE demo_two (id TEXT PRIMARY KEY);\n')
  const path = join(work, 'legacy-key.sqlite')
  const db = new DatabaseConstructor(path)
  db.exec(`
    CREATE TABLE schema_migrations (
      module      TEXT NOT NULL,
      version     INTEGER NOT NULL,
      applied_at  TEXT NOT NULL,
      PRIMARY KEY (module)
    );
  `)
  db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
    'demo', 1, '2026-01-01T00:00:00.000Z',
  )
  const result = runMigrations(db, { module: 'demo', dir })
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get().sql
  const rows = db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations WHERE module = 'demo' ORDER BY version")
    .all()
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('schema_migrations')")
    .all()
    .map((row) => row.name)
  db.close()
  assert.match(sql, /PRIMARY KEY \(module, version\)/)
  assert.ok(columns.includes('name') && columns.includes('checksum'))
  assert.equal(result.applied.length, 1)
  assert.equal(result.backfilled, 1)
  assert.deepEqual(rows.map((row) => row.version), [1, 2])
  assert.equal(rows[0].checksum, sha256(readFileSync(join(dir, '001_init.sql'), 'utf8')))
  assert.equal(rows[0].applied_at, '2026-01-01T00:00:00.000Z')
  return true
})

check('a max-only legacy row is backfilled, never re-executed', () => {
  const dir = join(work, 'legacy-max')
  mkdirSync(dir, { recursive: true })
  // No IF NOT EXISTS: re-running v1 would throw instead of passing silently.
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE demo_one (id TEXT PRIMARY KEY);\n')
  writeFileSync(join(dir, '002_more.sql'), 'ALTER TABLE demo_one ADD COLUMN label TEXT;\n')
  const path = join(work, 'legacy-max.sqlite')
  const db = new DatabaseConstructor(path)
  db.exec(`
    CREATE TABLE schema_migrations (
      module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    );
    CREATE TABLE demo_one (id TEXT PRIMARY KEY);
    ALTER TABLE demo_one ADD COLUMN label TEXT;
  `)
  db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
    'demo', 2, '2026-02-02T00:00:00.000Z',
  )
  const result = runMigrations(db, { module: 'demo', dir })
  const rows = db
    .prepare("SELECT version, checksum, applied_at FROM schema_migrations WHERE module = 'demo' ORDER BY version")
    .all()
  db.close()
  assert.equal(result.applied.length, 0)
  assert.equal(result.backfilled, 2)
  assert.deepEqual(rows.map((row) => row.version), [1, 2])
  assert.equal(rows[0].applied_at, '2026-02-02T00:00:00.000Z')
  return rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))
})

check('a production-shaped metadata table gains the missing columns', () => {
  const dir = join(work, 'prod-shape')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE demo_one (id TEXT PRIMARY KEY);\n')
  writeFileSync(join(dir, '002_more.sql'), 'CREATE TABLE demo_two (id TEXT PRIMARY KEY);\n')
  const path = join(work, 'prod-shape.sqlite')
  const db = new DatabaseConstructor(path)
  // Exactly the shape production has today: composite key, no name/checksum,
  // and only the highest version recorded (rows 1..2 exist, 1 is synthesised).
  db.exec(`
    CREATE TABLE schema_migrations (
      module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    );
    CREATE TABLE demo_one (id TEXT PRIMARY KEY);
    CREATE TABLE demo_two (id TEXT PRIMARY KEY);
  `)
  db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
    'demo', 2, '2026-03-03T00:00:00.000Z',
  )
  runMigrations(db, { module: 'demo', dir })
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('schema_migrations')")
    .all()
    .map((row) => row.name)
  const rows = db
    .prepare("SELECT version, checksum FROM schema_migrations WHERE module = 'demo' ORDER BY version")
    .all()
  db.close()
  assert.ok(columns.includes('name') && columns.includes('checksum'))
  assert.deepEqual(rows.map((row) => row.version), [1, 2])
  return rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))
})

check('gateway keeps its expand → migrate → contract trio as files', () => {
  const files = loadMigrationFiles(GATEWAY_DIR).map((file) => file.name)
  const start = files.indexOf('004_session_routes_chat_id.sql')
  return start !== -1
    && files[start + 1] === '005_session_routes_backfill.sql'
    && files[start + 2] === '006_session_routes_contract.sql'
})

check('tasks and gateway stores no longer carry inline migration arrays', () => {
  for (const module of ['tasks', 'gateway']) {
    const source = readFileSync(join(root, `plugins/${module}/src/store.ts`), 'utf8')
    assert.equal(/const MIGRATIONS\b/.test(source), false, `${module} still has const MIGRATIONS`)
    assert.match(source, /runMigrations\(db/, `${module} does not call runMigrations`)
  }
  return true
})

rmSync(work, { recursive: true, force: true })

console.log(`\nmigrations: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
