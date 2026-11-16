/**
 * Backup (docs/16 §七): one consistent restore point = `VACUUM INTO` snapshot of
 * ops.sqlite + memory/snapshots/outbox files + config, tarred under a single tag,
 * with a sha256 sidecar and a row-count manifest the restore drill can compare.
 *
 *   node scripts/backup.mjs [--data-dir /var/lib/dsh-wfxm] [--out /var/backups/dsh-wfxm]
 *                           [--config-dir /etc/dsh-wfxm] [--restic-repo <repo>]
 *                           [--keep 7] [--no-prune]
 *
 * restic is optional: configured → real `restic backup` with the same tag;
 * absent → clear "skipped", never a silent success.
 *
 * Retention (docs/16 §七): after a successful run only the newest `keep`
 * `dsh-wfxm-<tag>.tar.gz` archives (and their .sha256 sidecars) are kept.
 * `--keep 0` / `--no-prune` disables pruning; nothing that does not match the
 * archive naming pattern is ever removed.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const dataDir = resolve(option('data-dir', process.env.DSH_WFXM_DATA_DIR ?? '/var/lib/dsh-wfxm'))
const outDir = resolve(option('out', process.env.DSH_WFXM_BACKUP_DIR ?? '/var/backups/dsh-wfxm'))
const configDir = option('config-dir', existsSync('/etc/dsh-wfxm') ? '/etc/dsh-wfxm' : null)
const resticRepo = option('restic-repo', process.env.DSH_WFXM_RESTIC_REPO ?? null)
const keepRaw = option('keep', process.env.DSH_WFXM_BACKUP_KEEP ?? '7')
const noPrune = args.includes('--no-prune')
const dbPath = join(dataDir, 'ops.sqlite')
const COUNTED = ['projects', 'memory_facts', 'tasks', 'task_events', 'grants', 'approvals', 'outbox', 'inbox']

function fail(message) {
  console.error(`backup: ${message}`)
  process.exit(1)
}

if (!/^\d+$/.test(String(keepRaw).trim())) fail(`invalid --keep/DSH_WFXM_BACKUP_KEEP: ${keepRaw} (expected an integer >= 0)`)
const keep = Number(keepRaw)
if (!Number.isSafeInteger(keep)) fail(`invalid --keep/DSH_WFXM_BACKUP_KEEP: ${keepRaw} (expected an integer >= 0)`)

if (!existsSync(dbPath)) fail(`no database at ${dbPath} (is this the data dir?)`)

const ARCHIVE = /^dsh-wfxm-\d{8}T\d{6}Z\.tar\.gz$/

function prune(dir, limit) {
  const names = readdirSync(dir)
    .filter((name) => ARCHIVE.test(name))
    .sort()
    .reverse()
  if (limit === 0) return { kept: names.length, removed: 0 }
  const stale = names.slice(limit)
  for (const name of stale) {
    rmSync(join(dir, name), { force: true })
    rmSync(join(dir, `${name}.sha256`), { force: true })
  }
  return { kept: names.length - stale.length, removed: stale.length }
}

const tag = `dsh-wfxm-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')}`
const staging = mkdtempSync(join(tmpdir(), 'wfxm-backup-'))

try {
  // 1. SQLite consistency snapshot, not a file copy: WAL is folded in.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const escaped = join(staging, 'ops.sqlite').replaceAll("'", "''")
    db.exec(`VACUUM INTO '${escaped}'`)
    const counts = {}
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    )
    for (const table of COUNTED) {
      if (tables.has(table)) counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
    }
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    if (integrity !== 'ok') fail(`source database integrity_check = ${integrity}`)

    // 2. Data directories the DB references (docs/16 §七: same tag, one point).
    const components = ['ops.sqlite']
    for (const dir of ['memory', 'snapshots', 'outbox-files']) {
      const from = join(dataDir, dir)
      if (!existsSync(from)) continue
      cpSync(from, join(staging, dir), { recursive: true, dereference: false })
      components.push(dir)
    }
    if (configDir !== null && existsSync(configDir)) {
      cpSync(configDir, join(staging, 'config'), { recursive: true, dereference: false })
      components.push('config')
    }

    // 3. Manifest: what restore-drill compares against.
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify(
        { tag, createdAt: new Date().toISOString(), source: { dataDir, dbPath }, counts, components, node: process.version },
        null,
        2,
      )}\n`,
    )
  } finally {
    db.close()
  }

  mkdirSync(outDir, { recursive: true })
  const archive = join(outDir, `${tag}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'pipe' })
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(`${archive}.sha256`, `${hash}  ${basename(archive)}\n`)
  const size = statSync(archive).size

  // 4. Off-site copy is a separate, explicit step; never claim it silently.
  if (resticRepo !== null) {
    execFileSync('restic', ['-r', resticRepo, 'backup', '--tag', tag, staging], { stdio: 'inherit' })
    console.log(`restic: tagged ${tag} in ${resticRepo}`)
  } else {
    console.log('restic: skipped (no --restic-repo / DSH_WFXM_RESTIC_REPO)')
  }

  console.log(`backup: ${archive} (${size} bytes, sha256 ${hash.slice(0, 16)}…)`)
  console.log(`manifest: ${JSON.stringify(JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')).counts)}`)

  if (noPrune) {
    console.log('prune: skipped (--no-prune)')
  } else {
    const { kept, removed } = prune(outDir, keep)
    console.log(`prune: kept ${kept}, removed ${removed} (keep=${keep})`)
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
