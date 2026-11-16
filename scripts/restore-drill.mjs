/**
 * Restore drill (docs/16 §七 / 验收 #8): restore a backup into a clean directory
 * and prove it is usable — integrity, row counts against the manifest, then the
 * real eight-step startup check on the restored data.
 *
 *   node scripts/restore-drill.mjs --archive /var/backups/dsh-wfxm/dsh-wfxm-<tag>.tar.gz [--into /tmp/restore]
 *
 * Without --into the drill extracts to a temp dir and removes it. This is the
 * monthly exercise: "没跑的测试不算绿".
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const serveScript = fileURLToPath(new URL('serve.mjs', import.meta.url))

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const archive = option('archive', null)
const into = option('into', null)
if (archive === null) {
  console.error('restore-drill: --archive <tar.gz> is required')
  process.exit(1)
}

function fail(message) {
  // `process.exit()` skips `finally`, so a refused drill would leak its temp dir.
  if (tempTarget !== null) rmSync(tempTarget, { recursive: true, force: true })
  console.error(`restore-drill: ${message}`)
  process.exit(1)
}

let tempTarget = null

const source = resolve(archive)
if (!existsSync(source)) fail(`archive not found: ${source}`)

// 1. Integrity of the artifact itself before trusting its contents.
const sidecar = `${source}.sha256`
if (existsSync(sidecar)) {
  const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
  const actual = createHash('sha256').update(readFileSync(source)).digest('hex')
  if (expected !== actual) fail(`sha256 mismatch: expected ${expected}, got ${actual}`)
  console.log(`sha256 ok (${actual.slice(0, 16)}…)`)
} else {
  console.log('sha256: sidecar missing, skipped')
}

const target = into === null ? mkdtempSync(join(tmpdir(), 'wfxm-restore-')) : resolve(into)
const keep = into !== null
if (!keep) tempTarget = target
if (keep && existsSync(join(target, 'ops.sqlite'))) fail(`refusing to restore into a non-empty dir: ${target}`)

try {
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-xzf', source, '-C', target], { stdio: 'pipe' })
  const manifestPath = join(target, 'manifest.json')
  if (!existsSync(manifestPath)) fail('manifest.json missing from archive')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // 2. The database must open, pass integrity_check, and still hold what the
  //    manifest promised at backup time.
  const dbPath = join(target, 'ops.sqlite')
  if (!existsSync(dbPath)) fail('ops.sqlite missing from archive')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let counts
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    if (integrity !== 'ok') fail(`integrity_check = ${integrity}`)
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    )
    counts = {}
    for (const [table, expected] of Object.entries(manifest.counts ?? {})) {
      if (!tables.has(table)) fail(`table ${table} missing after restore`)
      const actual = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
      if (actual !== expected) fail(`row count mismatch for ${table}: manifest ${expected}, restored ${actual}`)
      counts[table] = actual
    }
    const modules = db
      .prepare('SELECT module FROM schema_migrations ORDER BY module')
      .all()
      .map((row) => row.module)
    if (modules.length === 0) fail('schema_migrations is empty')
    counts.modules = modules.length
  } finally {
    db.close()
  }

  // 3. Same-tag components must all be there (docs/16 §七 快照点一致).
  for (const component of manifest.components ?? []) {
    if (component === 'ops.sqlite') continue
    if (!existsSync(join(target, component))) fail(`component ${component} missing after restore`)
  }

  // 4. The drill's real assertion: the restored data can carry a full startup.
  const env = { ...process.env }
  delete env.LD_LIBRARY_PATH
  const output = execFileSync(process.execPath, [serveScript, '--check'], {
    encoding: 'utf8',
    env: { ...env, DSH_WFXM_DATA_DIR: target, DSH_WFXM_CHANNEL: 'loopback', DSH_WFXM_FOREGROUND: 'rule' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!output.includes('[startup] 8/8')) fail(`restored data failed startup:\n${output}`)

  console.log(`restored ${manifest.tag ?? 'unknown tag'} → ${target}`)
  console.log(`counts ${JSON.stringify(counts)}`)
  console.log('startup 8/8 ok on restored data')
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (!keep) rmSync(target, { recursive: true, force: true })
  else console.log(`kept restored copy at ${target}`)
}
