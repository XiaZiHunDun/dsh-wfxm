/**
 * Blue-green release verification (slice H): prepare → verify → switch →
 * rollback, plus the refusals that make N-1 trustworthy.
 *
 *   node scripts/verify-release.mjs
 *
 * Uses a temp root on the same filesystem (hard-linked dependency trees), so
 * no /opt and no root are needed. Real child processes, real release copies.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const releaseScript = join(repoRoot, 'scripts/release.mjs')
const root = mkdtempSync(join(tmpdir(), 'wfxm-release-'))
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

function run(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.LD_LIBRARY_PATH
  try {
    const stdout = execFileSync(process.execPath, [releaseScript, ...args, '--root', root], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? error.message}` }
  }
}

function current() {
  const result = run(['current'])
  return result.code === 0 ? realpathSync(join(root, 'current')) : null
}

check('prepare v1 → 自检八步全过（跑的是 release 自己的代码）', () => {
  const prepared = run(['prepare', '--version', 'v1'])
  assert(prepared.code === 0, prepared.output)
  // release.mjs 链接 `node_modules` + 每个带 node_modules 的插件目录；按实际数量断言，
  // 避免每加一个包就要改常量（Slice AT 踩过一次）。
  const linkedTrees = 1 + readdirSync(join(repoRoot, 'plugins'))
    .filter((name) => existsSync(join(repoRoot, 'plugins', name, 'node_modules'))).length
  assert(prepared.output.includes(`deps linked=${linkedTrees}`), `deps not hard-linked: ${prepared.output}`)
  const verified = run(['verify', '--version', 'v1'])
  assert(verified.code === 0, verified.output)
  assert(verified.output.includes('[startup] 8/8'), verified.output)
  const manifest = JSON.parse(readFileSync(join(root, 'releases/v1/release.json'), 'utf8'))
  assert(manifest.version === 'v1' && manifest.commit !== undefined, 'release.json incomplete')
  return `commit=${manifest.commit?.slice(0, 8) ?? 'none'}`
})

check('release 的 @dsh-wfxm 链接指向 release 内部，不是当前 checkout', () => {
  const link = join(root, 'releases/v1/node_modules/@dsh-wfxm/gateway')
  const resolved = realpathSync(link)
  assert(resolved.startsWith(realpathSync(root)), `resolved outside root: ${resolved}`)
  assert(resolved === join(root, 'releases/v1/plugins/gateway'), `resolved=${resolved}`)
  return 'self-contained'
})

check('switch 是原子软链切换，list 标出 current', () => {
  const switched = run(['switch', '--version', 'v1'])
  assert(switched.code === 0, switched.output)
  assert(current() === join(root, 'releases/v1'), `current=${current()}`)
  const listed = run(['list'])
  assert(listed.output.includes('* v1'), listed.output)
  return '* v1'
})

check('切到 v2 后 rollback 回到 N-1，且 N-1 仍可 verify', () => {
  assert(run(['prepare', '--version', 'v2']).code === 0, 'prepare v2 failed')
  assert(run(['verify', '--version', 'v2']).code === 0, 'verify v2 failed')
  assert(run(['switch', '--version', 'v2']).code === 0, 'switch v2 failed')
  assert(current() === join(root, 'releases/v2'), 'current not v2')
  const rollback = run(['rollback'])
  assert(rollback.code === 0, rollback.output)
  assert(rollback.output.includes('rolled back from v2 to v1'), rollback.output)
  assert(current() === join(root, 'releases/v1'), `current=${current()}`)
  assert(run(['verify', '--version', 'v1']).code === 0, 'N-1 no longer verifies')
  return 'v2 → v1'
})

check('坏版本被 verify 与 switch 双重拒绝（缺 startup 库）', () => {
  assert(run(['prepare', '--version', 'broken']).code === 0, 'prepare broken failed')
  unlinkSync(join(root, 'releases/broken/scripts/lib/startup.mjs'))
  const verified = run(['verify', '--version', 'broken'])
  assert(verified.code === 1, `verify accepted a broken release (exit ${verified.code})`)
  assert(verified.output.includes('release check failed'), verified.output)
  const switched = run(['switch', '--version', 'broken'])
  assert(switched.code === 1 && switched.output.includes('incomplete'), switched.output)
  assert(current() === join(root, 'releases/v1'), 'current moved to a broken release')
  return 'refused at verify and switch'
})

check('重复版本与不存在的版本都被拒绝', () => {
  const duplicate = run(['prepare', '--version', 'v1'])
  assert(duplicate.code === 1 && duplicate.output.includes('already exists'), duplicate.output)
  const missing = run(['switch', '--version', 'nope'])
  assert(missing.code === 1 && missing.output.includes('no such release'), missing.output)
  return 'both exit 1'
})

check('硬门禁失败：prepare 退出 1 且给 owner 留下通知（P7-5）', () => {
  const emptyEngine = mkdtempSync(join(tmpdir(), 'wfxm-no-engine-'))
  const gate = run(['prepare', '--version', 'gated'], {
    EVAL_HARD_GATE: '1',
    AGENT_EVAL_ROOT: emptyEngine,
  })
  rmSync(emptyEngine, { recursive: true, force: true })
  assert(gate.code === 1, `hard gate did not block (exit ${gate.code}): ${gate.output}`)
  assert(gate.output.includes('eval hard gate blocked'), gate.output)

  const dir = join(root, 'notify')
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
  assert(names.length === 1, `expected 1 queued notification, got ${names.length}`)
  const item = JSON.parse(readFileSync(join(dir, names[0]), 'utf8'))
  assert(item.kind === 'release-gate', `kind=${String(item.kind)}`)
  assert(item.text.includes('gated'), item.text)
  assert(item.text.includes('硬门禁'), item.text)
  return `${names[0]} → spool`
})

check('gc 永不删除 current，只按数量清理更旧的', () => {
  assert(run(['prepare', '--version', 'v3']).code === 0, 'prepare v3 failed')
  const gc = run(['gc', '--keep', '1'])
  assert(gc.code === 0, gc.output)
  assert(existsSync(join(root, 'releases/v1')), 'current release was deleted')
  assert(!existsSync(join(root, 'releases/v2')), 'old release not collected')
  return 'kept v1 (current)'
})

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
