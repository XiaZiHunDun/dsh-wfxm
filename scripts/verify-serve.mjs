/**
 * Production entry verification (slice H): the eight startup steps must run in
 * order, clean up after themselves, and **refuse to start** when one breaks.
 *
 * Real child processes, real SQLite, real loopback channel — only Feishu is out
 * of scope here (that needs the owner's bot, and `--check` on the real channel
 * would open a second long connection). Every case that claims "refused" checks
 * the exit code *and* which step refused.
 *
 *   node scripts/verify-serve.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import {
  StartupError,
  assertModules,
  assertZeroToolAsset,
  parseServeConfig,
  runStartup,
} from './lib/startup.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const service = join(repoRoot, 'scripts/serve.mjs')
const roots = []
let passed = 0
let failed = 0

function assert(ok, message) {
  if (!ok) throw new Error(message)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    passed += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`)
  }
}

function tempDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wfxm-serve-${label}-`))
  roots.push(dir)
  return dir
}

const baseEnv = { ...process.env }
delete baseEnv.LD_LIBRARY_PATH

function envFor(dataDir, overrides = {}) {
  return {
    ...baseEnv,
    DSH_WFXM_DATA_DIR: dataDir,
    DSH_WFXM_CHANNEL: 'loopback',
    DSH_WFXM_FOREGROUND: 'rule',
    ...overrides,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function runServe(args, env) {
  const child = spawn(process.execPath, [service, ...args], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.on('data', (chunk) => chunks.push(chunk))
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, done, output: () => Buffer.concat(chunks).toString('utf8') }
}

async function startServe(env, label) {
  const run = runServe([], env)
  try {
    await waitFor(
      () => existsSync(env.DSH_WFXM_READINESS ?? join(env.DSH_WFXM_DATA_DIR, 'readiness')),
      15_000,
      `${label} readiness`,
    )
  } catch (error) {
    run.child.kill('SIGKILL')
    throw new Error(`${error.message}\n${run.output()}`)
  }
  return run
}

async function stopServe(run, signal = 'SIGTERM') {
  run.child.kill(signal)
  return run.done
}

// ---- 1. --check 走完八步并清理 ------------------------------------------------------

await check('--check 八步全过，readiness 与锁被清理', async () => {
  const dataDir = tempDir('check')
  const run = runServe(['--check'], envFor(dataDir))
  const { code } = await run.done
  const out = run.output()
  assert(code === 0, `exit=${code}\n${out}`)
  for (let step = 1; step <= 8; step += 1) {
    assert(out.includes(`[startup] ${step}/8`), `missing step ${step}/8\n${out}`)
  }
  assert(!existsSync(join(dataDir, 'readiness')), 'readiness not cleaned')
  assert(!existsSync(join(dataDir, 'serve.lock')), 'lock not cleaned')
  return 'steps 1-8'
})

// ---- 2. 迁移真的落库 ---------------------------------------------------------------

await check('storage 步把各模块迁移写进 ops.sqlite（integrity ok）', async () => {
  const dataDir = tempDir('schema')
  const run = runServe(['--check'], envFor(dataDir))
  const { code } = await run.done
  assert(code === 0, `exit=${code}\n${run.output()}`)
  const db = new DatabaseSync(join(dataDir, 'ops.sqlite'))
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    assert(integrity.integrity_check === 'ok', `integrity=${JSON.stringify(integrity)}`)
    const modules = db.prepare('SELECT module FROM schema_migrations ORDER BY module').all().map((row) => row.module)
    for (const required of ['gateway', 'tasks', 'memory', 'snapshot']) {
      assert(modules.includes(required), `module ${required} not migrated (have ${modules.join(',')})`)
    }
    return `modules=${modules.join(',')}`
  } finally {
    db.close()
  }
})

// ---- 3. 配置校验（步 1） ------------------------------------------------------------

await check('配置非法值拒绝启动（步 1），默认路径由 DATA_DIR 派生', async () => {
  let error = null
  try {
    parseServeConfig({ DSH_WFXM_DATA_DIR: '/srv/x', DSH_WFXM_PUMP_INTERVAL_MS: 'abc' })
  } catch (caught) {
    error = caught
  }
  assert(error instanceof StartupError, 'invalid config was accepted')
  assert(error.step === 1 && error.stepName === 'config', `step=${error.step}/${error.stepName}`)
  assert(error.message.includes('DSH_WFXM_PUMP_INTERVAL_MS'), error.message)
  const config = parseServeConfig({ DSH_WFXM_DATA_DIR: '/srv/x' })
  assert(config.dbPath === '/srv/x/ops.sqlite', `dbPath=${config.dbPath}`)
  assert(config.readinessPath === '/srv/x/readiness', `readiness=${config.readinessPath}`)
  assert(config.semanticDigest === true, 'semantic digest should default to on')
  assert(parseServeConfig({ DSH_WFXM_DATA_DIR: '/srv/x', DSH_WFXM_SEMANTIC_DIGEST: '0' }).semanticDigest === false,
    'DSH_WFXM_SEMANTIC_DIGEST=0 did not disable it')
  assert(config.worktreeIsolation === false, 'worktree isolation should default off')
  assert(parseServeConfig({ DSH_WFXM_DATA_DIR: '/srv/x', DSH_WFXM_WORKTREE_ISOLATION: '1' }).worktreeIsolation === true,
    'DSH_WFXM_WORKTREE_ISOLATION=1 did not enable it')
  assert(config.resourceLocks === false, 'resource locks should default off')
  assert(parseServeConfig({ DSH_WFXM_DATA_DIR: '/srv/x', DSH_WFXM_RESOURCE_LOCKS: '1' }).resourceLocks === true,
    'DSH_WFXM_RESOURCE_LOCKS=1 did not enable it')
  return error.message
})

// ---- 4. 模块缺失拒绝启动（步 3） ----------------------------------------------------

await check('缺任一模块 API 即拒绝启动（步 3）', async () => {
  let error = null
  try {
    assertModules({ createMemoryStore: () => {}, createSnapshotStore: undefined })
  } catch (caught) {
    error = caught
  }
  assert(error instanceof StartupError, 'missing module accepted')
  assert(error.step === 3 && error.stepName === 'modules', `step=${error.step}/${error.stepName}`)
  assert(error.message.includes('createSnapshotStore'), error.message)
  return 'missing createSnapshotStore refused'
})

// ---- 5. 前台风口（步 4） ------------------------------------------------------------

await check('零工具叠加被破坏即拒绝启动（步 4）', async () => {
  const real = join(repoRoot, 'plugins/orchestrator/assets/frontdesk.sdk.patch.yml')
  const checked = assertZeroToolAsset(real)
  assert(checked > 0, 'real overlay has no tool entries')
  const dir = tempDir('overlay')
  const broken = join(dir, 'broken.yml')
  writeFileSync(broken, '- id: tool-bash\n  disabled: false\n')
  let error = null
  try {
    assertZeroToolAsset(broken)
  } catch (caught) {
    error = caught
  }
  assert(error instanceof StartupError, 'enabled tool accepted')
  assert(error.step === 4 && error.stepName === 'profile', `step=${error.step}/${error.stepName}`)
  assert(error.message.includes('tool-bash'), error.message)
  return `real=${checked} tool entries; broken refused`
})

// ---- 6. 端口探活（步 5） ------------------------------------------------------------

await check('dsh 二进制不可执行即拒绝启动（步 5）', async () => {
  const dataDir = tempDir('ports')
  const run = runServe(['--check'], envFor(dataDir, { DSH_WFXM_DSH_BIN: '/nonexistent/dsh' }))
  const { code } = await run.done
  const out = run.output()
  assert(code === 1, `exit=${code}\n${out}`)
  assert(out.includes('step: "5/8"') || out.includes('5/8'), `no step 5 in log\n${out}`)
  assert(out.includes('dsh binary not executable'), out)
  assert(!existsSync(join(dataDir, 'readiness')), 'readiness written despite failure')
  return 'refused at ports'
})

// ---- 7. readiness 写不进去（步 8） --------------------------------------------------

await check('readiness 不可写即拒绝启动（步 8）', async () => {
  const dataDir = tempDir('readiness')
  const blocker = join(dataDir, 'blocker')
  writeFileSync(blocker, 'not a directory\n')
  const run = runServe(['--check'], envFor(dataDir, { DSH_WFXM_READINESS: join(blocker, 'readiness') }))
  const { code } = await run.done
  const out = run.output()
  assert(code === 1, `exit=${code}\n${out}`)
  assert(out.includes('8/8'), `no step 8 in log\n${out}`)
  assert(!existsSync(join(dataDir, 'serve.lock')), 'lock not released')
  return 'refused at readiness'
})

// ---- 8. fail-fast：后面的步骤不再执行 -----------------------------------------------

await check('自检失败后不再执行后续步骤', async () => {
  let ran = false
  let error = null
  try {
    await runStartup(
      [
        { id: 6, name: 'recovery', run() { throw new Error('boom') } },
        { id: 7, name: 'channel', run() { ran = true } },
      ],
      { logger: () => {}, total: 8 },
    )
  } catch (caught) {
    error = caught
  }
  assert(error instanceof StartupError, 'failure was swallowed')
  assert(error.step === 6 && error.name === 'StartupError', `step=${error.step}`)
  assert(ran === false, 'a later step ran after the failure')
  return 'stopped at recovery'
})

// ---- 9. 优雅停止 -------------------------------------------------------------------

await check('SIGTERM：readiness/锁清理，退出码 0', async () => {
  const dataDir = tempDir('term')
  const env = envFor(dataDir)
  const run = await startServe(env, 'first')
  const readiness = JSON.parse(readFileSync(join(dataDir, 'readiness'), 'utf8'))
  assert(readiness.pid === run.child.pid, `readiness pid=${readiness.pid}`)
  const { code } = await stopServe(run)
  assert(code === 0, `exit=${code}\n${run.output()}`)
  assert(!existsSync(join(dataDir, 'readiness')), 'readiness left behind')
  assert(!existsSync(join(dataDir, 'serve.lock')), 'lock left behind')
  return `pid=${readiness.pid}`
})

// ---- 10. 单实例 --------------------------------------------------------------------

await check('第二个实例被拒绝（退出码 3），第一个不受影响', async () => {
  const dataDir = tempDir('dup')
  const env = envFor(dataDir)
  const first = await startServe(env, 'first')
  const second = runServe(['--check'], env)
  const { code } = await second.done
  const out = second.output()
  assert(code === 3, `second exit=${code}\n${out}`)
  assert(out.includes('another instance is running'), out)
  assert(first.child.exitCode === null, 'first instance died')
  const stopped = await stopServe(first)
  assert(stopped.code === 0, `first exit=${stopped.code}\n${first.output()}`)
  return 'refused with 3'
})

// ---- 11. 陈旧锁回收 ----------------------------------------------------------------

await check('持有者已死的陈旧锁被回收，正常启动', async () => {
  const dataDir = tempDir('stale')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'serve.lock'), `${JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() })}\n`)
  const run = await startServe(envFor(dataDir), 'stale')
  const { code } = await stopServe(run)
  assert(code === 0, `exit=${code}\n${run.output()}`)
  return 'reclaimed 999999'
})

// ---- 12. 活锁不抢占 ----------------------------------------------------------------

await check('锁的持有进程仍活着时拒绝启动，且不删别人的锁', async () => {
  const dataDir = tempDir('live-lock')
  mkdirSync(dataDir, { recursive: true })
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  try {
    const lockPath = join(dataDir, 'serve.lock')
    writeFileSync(lockPath, `${JSON.stringify({ pid: sleeper.pid, startedAt: new Date().toISOString() })}\n`)
    const run = runServe(['--check'], envFor(dataDir))
    const { code } = await run.done
    assert(code === 3, `exit=${code}\n${run.output()}`)
    assert(existsSync(lockPath), 'live lock was removed')
    return `refused to steal pid=${sleeper.pid}`
  } finally {
    sleeper.kill('SIGKILL')
  }
})

for (const dir of roots) rmSync(dir, { recursive: true, force: true })

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
