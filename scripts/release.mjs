/**
 * Blue-green releases (docs/16 §六): `<root>/releases/<version>` + `<root>/current`
 * symlink. Switching is an atomic rename of the symlink, so a half-written
 * release can never be "current", and N-1 stays on disk for rollback.
 *
 *   node scripts/release.mjs prepare  --version 2026.11.11-1 [--root /opt/dsh-wfxm]
 *   node scripts/release.mjs verify   --version <v> [--root ...]
 *   node scripts/release.mjs switch   --version <v> [--root ...]
 *   node scripts/release.mjs rollback [--root ...]        # back to N-1
 *   node scripts/release.mjs list | current [--root ...]
 *   node scripts/release.mjs gc       --keep 3 [--root ...]
 *
 * `prepare` copies code and links dependency trees from this checkout
 * (hard links on the same filesystem, plain copy across devices). Relative
 * `node_modules` symlinks stay inside the release, so verify really exercises
 * the release, not the checkout.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const command = args[0]
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const root = resolve(option('root', '/opt/dsh-wfxm'))
const version = option('version', null)
const EXCLUDES = new Set(['node_modules', '.git', '.wfxm', 'releases', 'current', 'coverage', '.DS_Store'])
const REQUIRED = [
  'package.json',
  'scripts/serve.mjs',
  'scripts/lib/startup.mjs',
  'plugins/orchestrator/assets/frontdesk.sdk.patch.yml',
  'plugins/host/package.json',
  'plugins/gateway/package.json',
  'plugins/tasks/package.json',
]

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

function checkVersion(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail(`invalid --version ${JSON.stringify(value)}`)
  }
  return value
}

function releasesDir() {
  return join(root, 'releases')
}

function releasePath(value) {
  return join(releasesDir(), checkVersion(value))
}

function currentTarget() {
  const link = join(root, 'current')
  if (!existsSync(link)) return null
  try {
    return realpathSync(link)
  } catch {
    return null
  }
}

function listReleases() {
  const dir = releasesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ version: name, path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .sort((a, b) => b.at - a.at)
}

function linkDependencies(sourceRoot, destRoot) {
  const trees = ['node_modules']
  const pluginsDir = join(sourceRoot, 'plugins')
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      if (existsSync(join(pluginsDir, name, 'node_modules'))) trees.push(`plugins/${name}/node_modules`)
    }
  }
  let linked = 0
  let copied = 0
  for (const rel of trees) {
    const from = join(sourceRoot, rel)
    const to = join(destRoot, rel)
    if (!existsSync(from)) continue
    try {
      execFileSync('cp', ['-a', '--link', from, to], { stdio: 'pipe' })
      linked += 1
    } catch {
      cpSync(from, to, { recursive: true, dereference: false })
      copied += 1
    }
  }
  return { linked, copied }
}

function prepare() {
  checkVersion(version)
  const dest = releasePath(version)
  if (existsSync(dest)) fail(`release already exists: ${dest}`)
  const staging = `${dest}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    cpSync(repoRoot, staging, {
      recursive: true,
      dereference: false,
      filter: (src) => !EXCLUDES.has(src.split('/').pop()),
    })
    const deps = linkDependencies(repoRoot, staging)
    const commit = (() => {
      try {
        return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      } catch {
        return null
      }
    })()
    writeFileSync(
      join(staging, 'release.json'),
      `${JSON.stringify({ version, commit, node: process.version, preparedAt: new Date().toISOString(), deps }, null, 2)}\n`,
    )
    const missing = REQUIRED.filter((rel) => !existsSync(join(staging, rel)))
    if (missing.length > 0) throw new Error(`release incomplete, missing: ${missing.join(', ')}`)
    renameSync(staging, dest)
    console.log(`prepared ${dest} (deps linked=${deps.linked} copied=${deps.copied}, commit=${commit ?? 'none'})`)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    fail(error instanceof Error ? error.message : String(error))
  }
}

function verify() {
  const dest = releasePath(version)
  if (!existsSync(join(dest, 'scripts/serve.mjs'))) fail(`no such release: ${dest}`)
  // Self-contained check: the release's own module links must resolve inside it.
  const moduleLink = join(dest, 'node_modules/@dsh-wfxm/gateway')
  if (!existsSync(moduleLink)) fail(`dependency tree missing in release: ${moduleLink}`)
  const resolved = realpathSync(moduleLink)
  if (!resolved.startsWith(realpathSync(dest))) fail(`release links point outside itself: ${resolved}`)
  const dataDir = mkdtempSync(join(root, '.verify-'))
  try {
    const output = execFileSync(process.execPath, [join(dest, 'scripts/serve.mjs'), '--check'], {
      encoding: 'utf8',
      cwd: dest,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: undefined,
        DSH_WFXM_DATA_DIR: dataDir,
        DSH_WFXM_CHANNEL: 'loopback',
        DSH_WFXM_FOREGROUND: 'rule',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!output.includes('[startup] 8/8')) fail(`release check did not reach step 8:\n${output}`)
    console.log(`verified ${dest}`)
    for (const line of output.split('\n').filter((text) => text.includes('[startup]'))) console.log(`  ${line}`)
  } catch (error) {
    fail(`release check failed\n${error?.stdout ?? ''}${error?.stderr ?? error.message}`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

function switchTo(targetVersion) {
  const dest = releasePath(targetVersion)
  if (!existsSync(dest)) fail(`no such release: ${dest}`)
  const missing = REQUIRED.filter((rel) => !existsSync(join(dest, rel)))
  if (missing.length > 0) fail(`release ${targetVersion} is incomplete: ${missing.join(', ')}`)
  mkdirSync(root, { recursive: true })
  const tmp = join(root, `.current.${process.pid}`)
  rmSync(tmp, { force: true })
  symlinkSync(join('releases', targetVersion), tmp, 'dir')
  renameSync(tmp, join(root, 'current'))
  console.log(`current -> releases/${targetVersion}`)
}

function switchCommand() {
  checkVersion(version)
  switchTo(version)
}

function rollback() {
  const current = currentTarget()
  if (current === null) fail('no current release to roll back from')
  const currentVersion = current.split('/').pop()
  const previous = listReleases().find((entry) => entry.version !== currentVersion)
  if (previous === undefined) fail('no previous release available')
  switchTo(previous.version)
  console.log(`rolled back from ${currentVersion} to ${previous.version}`)
}

function listCommand() {
  const current = currentTarget()
  const entries = listReleases()
  if (entries.length === 0) {
    console.log('no releases')
    return
  }
  for (const entry of entries) {
    const marker = current !== null && current === realpathSync(entry.path) ? '*' : ' '
    console.log(`${marker} ${entry.version}\t${new Date(entry.at).toISOString()}\t${entry.path}`)
  }
}

function currentCommand() {
  const current = currentTarget()
  if (current === null) fail('no current release')
  console.log(current)
  try {
    console.log(readFileSync(join(current, 'release.json'), 'utf8').trim())
  } catch {
    // release.json is advisory
  }
}

function gc() {
  const keep = Number(option('keep', '3'))
  if (!Number.isInteger(keep) || keep < 1) fail('--keep must be a positive integer')
  const current = currentTarget()
  const entries = listReleases()
  const removed = []
  entries.slice(keep).forEach((entry) => {
    const path = realpathSync(entry.path)
    if (current !== null && path === current) return
    rmSync(path, { recursive: true, force: true })
    removed.push(entry.version)
  })
  console.log(removed.length === 0 ? 'nothing to remove' : `removed ${removed.join(', ')}`)
}

switch (command) {
  case 'prepare':
    prepare()
    break
  case 'verify':
    verify()
    break
  case 'switch':
    switchCommand()
    break
  case 'rollback':
    rollback()
    break
  case 'list':
    listCommand()
    break
  case 'current':
    currentCommand()
    break
  case 'gc':
    gc()
    break
  default:
    fail('usage: release.mjs prepare|verify|switch|rollback|list|current|gc [--version <v>] [--root <dir>]')
}
