/**
 * Backup / restore-drill verification (slice H): a backup that has never been
 * restored is not a backup. This seeds real data, backs it up, restores it into
 * a clean dir, and checks the refusals (tampered archive, counts mismatch).
 *
 *   node scripts/verify-backup.mjs
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMemoryStore } from '@dsh-wfxm/knowledge'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scripts = {
  serve: join(repoRoot, 'scripts/serve.mjs'),
  backup: join(repoRoot, 'scripts/backup.mjs'),
  drill: join(repoRoot, 'scripts/restore-drill.mjs'),
}
const roots = []
let passed = 0
let failed = 0

function assert(ok, message) {
  if (!ok) throw new Error(message)
}

function check(name, fn) {
  try {
    const detail = fn()
    passed += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wfxm-backup-${label}-`))
  roots.push(dir)
  return dir
}

function node(args, options = {}) {
  const env = { ...process.env }
  delete env.LD_LIBRARY_PATH
  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? error.message}` }
  }
}

// ---- seed: schema + one project row + one snapshot file -------------------------

const dataDir = tempDir('data')
const outDir = tempDir('out')
const checked = node([scripts.serve, '--check'], {
  env: { DSH_WFXM_DATA_DIR: dataDir, DSH_WFXM_CHANNEL: 'loopback', DSH_WFXM_FOREGROUND: 'rule' },
})
assert(checked.code === 0, `seed startup failed\n${checked.output}`)
const store = createMemoryStore(join(dataDir, 'ops.sqlite'))
try {
  store.upsertProject({ name: 'drill-project', rootPath: join(dataDir, 'workspace') })
} finally {
  store.close()
}
mkdirSync(join(dataDir, 'snapshots'), { recursive: true })
writeFileSync(join(dataDir, 'snapshots', 'blob-1.txt'), 'snapshot payload\n')

let archivePath = null

check('backup：产生归档 + sha256 + manifest，restic 未配置时明说跳过', () => {
  const result = node([scripts.backup, '--data-dir', dataDir, '--out', outDir])
  assert(result.code === 0, result.output)
  const archives = readdirSync(outDir).filter((name) => name.endsWith('.tar.gz'))
  assert(archives.length === 1, `archives=${archives.join(',')}`)
  archivePath = join(outDir, archives[0])
  assert(existsSync(`${archivePath}.sha256`), 'sha256 sidecar missing')
  const hash = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  assert(readFileSync(`${archivePath}.sha256`, 'utf8').startsWith(hash), 'sidecar hash mismatch')
  assert(result.output.includes('"projects":1'), result.output)
  assert(result.output.includes('restic: skipped'), result.output)
  return `${archives[0]}`
})

check('restore-drill：还原到干净目录，integrity/计数一致，八步自检通过', () => {
  const into = join(tempDir('restore'), 'copy')
  const result = node([scripts.drill, '--archive', archivePath, '--into', into])
  assert(result.code === 0, result.output)
  assert(result.output.includes('sha256 ok'), result.output)
  assert(result.output.includes('"projects":1'), result.output)
  assert(result.output.includes('startup 8/8 ok on restored data'), result.output)
  assert(existsSync(join(into, 'snapshots', 'blob-1.txt')), 'snapshot component not restored')
  assert(existsSync(join(into, 'manifest.json')), 'manifest not restored')
  return 'kept copy + 8/8'
})

check('归档被篡改时拒绝还原（sha256）', () => {
  const dir = tempDir('tamper')
  const copy = join(dir, 'tampered.tar.gz')
  const bytes = readFileSync(archivePath)
  writeFileSync(copy, Buffer.concat([bytes, Buffer.from('x')]))
  writeFileSync(`${copy}.sha256`, readFileSync(`${archivePath}.sha256`, 'utf8'))
  const result = node([scripts.drill, '--archive', copy])
  assert(result.code === 1, `tampered archive accepted (exit ${result.code})`)
  assert(result.output.includes('sha256 mismatch'), result.output)
  return 'refused'
})

check('缺 manifest 的归档被拒绝', () => {
  const dir = tempDir('nomanifest')
  const empty = join(dir, 'empty')
  mkdirSync(empty, { recursive: true })
  const bad = join(dir, 'bad.tar.gz')
  execFileSync('tar', ['-czf', bad, '-C', empty, '.'], { stdio: 'pipe' })
  const result = node([scripts.drill, '--archive', bad])
  assert(result.code === 1, `accepted an archive without manifest (exit ${result.code})`)
  assert(result.output.includes('manifest.json missing'), result.output)
  return 'refused'
})

check('行数与 manifest 不符时拒绝还原', () => {
  const work = tempDir('mismatch')
  execFileSync('tar', ['-xzf', archivePath, '-C', work], { stdio: 'pipe' })
  const manifestPath = join(work, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.counts.projects = 99
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const bad = join(tempDir('mismatch-out'), 'mismatch.tar.gz')
  execFileSync('tar', ['-czf', bad, '-C', work, '.'], { stdio: 'pipe' })
  const result = node([scripts.drill, '--archive', bad])
  assert(result.code === 1, `accepted a counts mismatch (exit ${result.code})`)
  assert(result.output.includes('row count mismatch for projects'), result.output)
  return 'refused'
})

check('数据目录里没有 ops.sqlite 时备份显式失败', () => {
  const empty = tempDir('empty-data')
  const result = node([scripts.backup, '--data-dir', empty, '--out', tempDir('empty-out')])
  assert(result.code === 1, `backup of an empty dir exited ${result.code}`)
  assert(result.output.includes('no database at'), result.output)
  return 'refused'
})

// ---- retention (slice T) ------------------------------------------------------

function fakeArchive(dir, tag) {
  const file = join(dir, `${tag}.tar.gz`)
  writeFileSync(file, 'old archive\n')
  writeFileSync(`${file}.sha256`, `${'0'.repeat(64)}  ${tag}.tar.gz\n`)
  return file
}

const ARCHIVE = /^dsh-wfxm-\d{8}T\d{6}Z\.tar\.gz$/

check('保留策略：--keep 2 只留最新两份，旧归档与 sha256 一并清理，非匹配文件不动', () => {
  const out = tempDir('keep2')
  const old = fakeArchive(out, 'dsh-wfxm-20260101T000000Z')
  const mid = fakeArchive(out, 'dsh-wfxm-20260102T000000Z')
  writeFileSync(join(out, 'notes.txt'), 'keep me\n')
  writeFileSync(join(out, 'dsh-wfxm-latest.tar.gz'), 'not a dated archive\n')
  writeFileSync(join(out, 'other-20260101T000000Z.tar.gz'), 'other\n')
  const result = node([scripts.backup, '--data-dir', dataDir, '--out', out, '--keep', '2'])
  assert(result.code === 0, result.output)
  assert(result.output.includes('prune: kept 2, removed 1 (keep=2)'), result.output)
  const archives = readdirSync(out).filter((name) => ARCHIVE.test(name))
  assert(archives.length === 2, `dated archives=${archives.join(',')}`)
  assert(!existsSync(old) && !existsSync(`${old}.sha256`), 'oldest archive or its sidecar survived')
  assert(existsSync(mid) && existsSync(`${mid}.sha256`), 'second-newest archive was removed')
  assert(existsSync(join(out, 'notes.txt')), 'non-archive file was removed')
  assert(existsSync(join(out, 'dsh-wfxm-latest.tar.gz')), 'name not matching the tag pattern was removed')
  assert(existsSync(join(out, 'other-20260101T000000Z.tar.gz')), 'foreign archive was removed')
  return `${archives.join(', ')}`
})

check('保留策略：--keep 0 不清理任何归档', () => {
  const out = tempDir('keep0')
  const first = fakeArchive(out, 'dsh-wfxm-20260101T000000Z')
  const second = fakeArchive(out, 'dsh-wfxm-20260102T000000Z')
  const result = node([scripts.backup, '--data-dir', dataDir, '--out', out, '--keep', '0'])
  assert(result.code === 0, result.output)
  assert(result.output.includes('prune: kept 3, removed 0 (keep=0)'), result.output)
  assert(existsSync(first) && existsSync(second), 'keep=0 must not remove older archives')
  const archives = readdirSync(out).filter((name) => ARCHIVE.test(name))
  assert(archives.length === 3, `dated archives=${archives.join(',')}`)
  return '3 kept'
})

check('保留策略：非法 --keep 显式失败且不写新归档', () => {
  const out = tempDir('keepbad')
  const result = node([scripts.backup, '--data-dir', dataDir, '--out', out, '--keep', 'two'])
  assert(result.code === 1, `invalid keep exited ${result.code}`)
  assert(result.output.includes('invalid --keep'), result.output)
  assert(readdirSync(out).length === 0, `invalid keep still wrote ${readdirSync(out).join(',')}`)
  return 'refused'
})

for (const dir of roots) rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
