/**
 * P2-1..P2-4 `/eval` 闭环验收：命令解析、快照、限流、run 落库、flag/promote/ignore、
 * 硬门禁与周报。
 *
 * 无网络、无模型、无 dsh；用真实 SQLite + 假 transport，验证的是接线本身。
 * promote/门禁用临时 stub，不依赖 agent-eval 是否在本机。
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function ensureBuilt(pkg) {
  const pkgRoot = join(root, 'plugins', pkg)
  const libFile = join(pkgRoot, 'lib', 'index.js')
  const srcDir = join(pkgRoot, 'src')
  const newest = Math.max(
    0,
    ...readdirSync(srcDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => statSync(join(srcDir, file)).mtimeMs),
  )
  const stale = !existsSync(libFile) || statSync(libFile).mtimeMs < newest
  if (stale) {
    const tsc = join(root, 'plugins', 'executor', 'node_modules', 'typescript', 'bin', 'tsc')
    execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, 'tsconfig.json')], { stdio: 'inherit' })
  }
}

ensureBuilt('eval')
ensureBuilt('gateway')
ensureBuilt('host')

const { parseEvalCommand } = await import('../plugins/gateway/lib/index.js')
const { createEvalStore, digestText, createCandidatePromoter, createTrajectoryCandidate, formatEvalWeekly } = await import('../plugins/eval/lib/index.js')
const {
  createWfxmHost,
  formatEvalFindings,
  formatEvalStatus,
  loadEvalSnapshot,
} = await import('../plugins/host/lib/index.js')

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    const ok = await fn()
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name}`)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'eval-loop-'))
const CHANNEL = 'feishu'
const CHAT = 'oc_eval'
const CLOCK = new Date('2026-11-24T10:00:00.000Z')
const now = () => new Date(CLOCK)

const SNAPSHOT = {
  version: 1,
  recordedAt: '2026-11-24T09:00:00.000Z',
  source: 'test',
  advisory: true,
  gate: {
    ok: true,
    advisory: true,
    suites: [
      { name: 'smoke', passed: 6, total: 6, rate: 1 },
      { name: 'tools', passed: 12, total: 12, rate: 1 },
    ],
  },
  real: {
    capability: {
      passed: 16,
      total: 20,
      rate: 0.8,
      recordedAt: '2026-11-24T08:00:00.000Z',
      failures: [{ taskId: 'svc-inspect-ports', rate: 0 }],
    },
  },
  failures: [{ suite: 'capability', taskId: 'svc-inspect-ports', rate: 0 }],
}

const snapshotPath = join(dir, 'latest.json')
writeFileSync(snapshotPath, `${JSON.stringify(SNAPSHOT, null, 2)}\n`)

let hostSeq = 0
let msgSeq = 0
const uniqueMsg = (prefix = 'm') => {
  msgSeq += 1
  return `${prefix}_${msgSeq}`
}

const L2_OUTCOME = {
  ok: false,
  advisory: true,
  passed: 13,
  total: 14,
  suites: [
    { name: 'smoke', passed: 6, total: 6, rate: 1 },
    { name: 'tools', passed: 7, total: 8, rate: 0.875 },
  ],
  failures: [{ suite: 'tools', taskId: 'svc-inspect-ports', rate: 0, detail: '未使用受管工具' }],
  reportRef: '.eval-runs/test-l2',
  durationMs: 12,
}

function makeRunner(outcome = L2_OUTCOME) {
  const state = { calls: 0 }
  return {
    available: true,
    state,
    async run() {
      state.calls += 1
      return outcome
    },
  }
}

function makeTransport() {
  const sent = []
  return {
    sent,
    async send(delivery) {
      sent.push(delivery)
      return { externalMsgId: `om_${sent.length}` }
    },
  }
}

function makeHost(evalOptions, telemetry = null) {
  hostSeq += 1
  const dbPath = join(dir, `host-${hostSeq}.sqlite`)
  const evalStore = createEvalStore(dbPath)
  const transport = makeTransport()
  const host = createWfxmHost({
    dbPath,
    executor: () => ({ status: 'succeeded', summary: 'executor ok' }),
    transport,
    now,
    telemetry,
    eval: evalOptions === null ? null : { store: evalStore, ...(evalOptions ?? {}) },
  })
  return { host, transport, evalStore }
}

/** 生产回流只需要读轨迹；用假端口避免真的写遥测表。 */
function makeFakeTelemetry(byTask) {
  return {
    emit() { return true },
    flush() { return Promise.resolve() },
    close() {},
    stats() {
      return { mode: 'test', degraded: false, diskRatio: null, queueDepth: 0, events: 0, todayBytes: 0, dropped: {} }
    },
    attempts(taskId) {
      return byTask[taskId]?.attempts ?? []
    },
    attemptsSince() { return [] },
    query(input) {
      const rows = input.taskId === undefined ? [] : byTask[input.taskId]?.events ?? []
      return { rows, count: rows.length }
    },
  }
}

async function pair(host, { externalUserId = 'ou_owner', kind = 'owner' } = {}) {
  const actor = host.stores.gateway.createActor({ kind, displayName: kind })
  const { code } = host.stores.gateway.mintPairingCode({ actorId: actor.id, channelId: CHANNEL })
  await host.ingest({
    channelId: CHANNEL,
    msgId: uniqueMsg('bind'),
    externalUserId,
    content: { text: `/bind ${code}` },
    chatId: CHAT,
  })
  return actor
}

async function say(host, text, extra = {}) {
  const msgId = uniqueMsg()
  const result = await host.ingest({
    channelId: CHANNEL,
    msgId,
    externalUserId: 'ou_owner',
    content: { text },
    chatId: CHAT,
    ...extra,
  })
  await host.pump()
  return { result, msgId }
}

let stubSeq = 0
/** 临时 agent-eval 根：只需要 `src/contract.mjs`，避免依赖真实工作区。 */
function makeStubEvalRoot(validateSource) {
  stubSeq += 1
  const stubRoot = join(dir, `agent-eval-${stubSeq}`)
  mkdirSync(join(stubRoot, 'src'), { recursive: true })
  writeFileSync(join(stubRoot, 'src', 'contract.mjs'), validateSource, 'utf8')
  return stubRoot
}

/** 临时 agent-eval 门禁：写 gate.json 并按 `STUB_GATE_OK`/`--advisory` 决定退出码。 */
function makeStubGateEngine() {
  stubSeq += 1
  const stubRoot = join(dir, `gate-engine-${stubSeq}`)
  mkdirSync(join(stubRoot, 'src'), { recursive: true })
  writeFileSync(join(stubRoot, 'src', 'cli.mjs'), `
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
const out = process.argv[process.argv.indexOf('--out') + 1]
const ok = process.env.STUB_GATE_OK === '1'
const advisory = process.argv.includes('--advisory')
mkdirSync(out, { recursive: true })
const suites = [{ name: 'smoke', passed: ok ? 6 : 5, total: 6, rate: ok ? 1 : 0.83 }]
const dir = process.env.DSH_EVAL_TRAJECTORY_DIR
if (process.env.STUB_TRAJECTORY === '1' && dir) {
  const pass = process.env.STUB_TRAJECTORY_PASS !== '0'
  const results = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => {
    const task = JSON.parse(readFileSync(dir + '/' + name, 'utf8'))
    return { taskId: task.id, passed: pass, passRate: pass ? 1 : 0 }
  })
  mkdirSync(out + '/trajectory', { recursive: true })
  writeFileSync(out + '/trajectory/summary.json', JSON.stringify({ results }))
  suites.push({ name: 'trajectory', passed: pass ? results.length : 0, total: results.length, rate: pass ? 1 : 0 })
}
writeFileSync(out + '/gate.json', JSON.stringify({ ok, advisory, suites }))
process.exit(ok || advisory ? 0 : 1)
`, 'utf8')
  return stubRoot
}

const texts = (transport) => transport.sent
  .map((delivery) => delivery.payload?.text)
  .filter((text) => typeof text === 'string')

// ---- 命令解析 ---------------------------------------------------------------------

await check('/eval parses status, findings, help and rejects other subcommands', async () => {
  assert.deepEqual(parseEvalCommand('/eval'), { kind: 'status' })
  assert.deepEqual(parseEvalCommand('/EVAL status'), { kind: 'status' })
  assert.deepEqual(parseEvalCommand('/eval findings'), { kind: 'findings' })
  assert.deepEqual(parseEvalCommand('/eval help'), { kind: 'help' })
  assert.equal(parseEvalCommand('/evaluate'), null)
  assert.equal(parseEvalCommand('请看 /eval'), null)
  assert.deepEqual(parseEvalCommand('/eval run l2'), { kind: 'run', mode: 'l2' })
  assert.deepEqual(parseEvalCommand('/eval RUN real'), { kind: 'run', mode: 'real' })
  assert.equal(parseEvalCommand('/eval run nightly')?.kind, 'unsupported')
  assert.deepEqual(parseEvalCommand('/eval flag 回答不对'), { kind: 'flag', reason: '回答不对' })
  assert.equal(parseEvalCommand('/eval flag')?.kind, 'unsupported')
  assert.deepEqual(parseEvalCommand('/eval promote abc123'), { kind: 'promote', ref: 'abc123' })
  assert.deepEqual(parseEvalCommand('/eval fix abc123'), { kind: 'fix', ref: 'abc123' })
  assert.equal(parseEvalCommand('/eval fix')?.kind, 'unsupported')
  assert.deepEqual(parseEvalCommand('/eval refresh abc123'), { kind: 'refresh', ref: 'abc123' })
  assert.equal(parseEvalCommand('/eval refresh')?.kind, 'unsupported')
  assert.deepEqual(parseEvalCommand('/eval ignore #abc123'), { kind: 'ignore', ref: '#abc123' })
  assert.equal(parseEvalCommand('/eval promote')?.kind, 'unsupported')
  assert.deepEqual(parseEvalCommand('/eval from-task nhdn6m3wuh'), { kind: 'from-task', ref: 'nhdn6m3wuh' })
  assert.equal(parseEvalCommand('/eval from-task')?.kind, 'unsupported')
  return true
})

// ---- 快照读取与文案 ----------------------------------------------------------------

await check('snapshot loads and status/findings expose the same numbers', async () => {
  const load = loadEvalSnapshot(snapshotPath)
  assert.equal(load.ok, true)
  const status = formatEvalStatus(load)
  assert.match(status, /离线 L2：2\/2 套件通过/)
  assert.match(status, /capability 16\/20（80%）/)
  assert.match(status, /svc-inspect-ports/)
  const findings = formatEvalFindings(load)
  assert.match(findings, /未通过 1 项/)
  assert.match(findings, /svc-inspect-ports · capability/)
  return true
})

await check('a missing snapshot is reported, never treated as pass', async () => {
  const load = loadEvalSnapshot(join(dir, 'missing.json'))
  assert.equal(load.ok, false)
  assert.equal(load.reason, 'missing')
  const text = formatEvalStatus(load)
  assert.match(text, /暂无测评快照/)
  assert.doesNotMatch(text, /通过/)
  return true
})

// ---- Host 回执 --------------------------------------------------------------------

await check('/eval replies read-only and creates no task', async () => {
  const { host, transport } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  const { result } = await say(host, '/eval')
  const tasks = host.stores.tasks.listTasks()
  const replied = texts(transport).at(-1) ?? ''
  host.close()
  return result.result.bypassReason === 'eval'
    && result.result.target.kind === 'eval'
    && tasks.length === 0
    && replied.includes('capability 16/20')
    && replied.includes('advisory')
})

await check('/eval findings lists failures without touching the model', async () => {
  const { host, transport } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  await say(host, '/eval findings')
  const replied = texts(transport).at(-1) ?? ''
  const taskCount = host.stores.tasks.listTasks().length
  host.close()
  return replied.includes('svc-inspect-ports') && taskCount === 0
})

await check('a non-owner is refused', async () => {
  const { host, transport } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host, { externalUserId: 'ou_system', kind: 'system' })
  await host.ingest({
    channelId: CHANNEL,
    msgId: uniqueMsg(),
    externalUserId: 'ou_system',
    content: { text: '/eval' },
    chatId: CHAT,
  })
  await host.pump()
  const replied = texts(transport).at(-1) ?? ''
  host.close()
  return replied.includes('仅 owner')
})

await check('repeated reads inside the window are rate-limited', async () => {
  const { host, transport } = makeHost({ snapshotPath, rateLimitMs: 60_000 })
  await pair(host)
  await say(host, '/eval')
  // 第二条用不同文本，避免命中 identical-message 去重而看不出限流。
  await say(host, '/eval findings')
  const replied = texts(transport).at(-1) ?? ''
  host.close()
  return replied.includes('请求过于频繁')
})

// ---- P2-2 落库与执行 -------------------------------------------------------------

await check('run idempotency key and terminal state are enforced', async () => {
  const store = createEvalStore(join(dir, 'store.sqlite'))
  const first = store.recordRun({
    suite: 'l2',
    mode: 'l2',
    idempotencyKey: 'k1',
    startedAt: CLOCK.toISOString(),
  })
  const second = store.recordRun({
    suite: 'l2',
    mode: 'l2',
    idempotencyKey: 'k1',
    startedAt: CLOCK.toISOString(),
  })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.run.id, first.run.id)
  const ok = store.finishRun(first.run.id, { status: 'ok', passed: 5, total: 5 })
  const again = store.finishRun(first.run.id, { status: 'failed', passed: 0, total: 5 })
  assert.equal(ok.status, 'ok')
  assert.equal(again.status, 'ok')
  assert.equal(again.passed, 5)
  store.close()
  return true
})

await check('digest stores hash plus redacted summary', async () => {
  const digest = digestText('token=sk-abcdefghijklmnopqrstuvwxyz0123456789')
  assert.match(digest, /^sha256:[0-9a-f]{64} /)
  assert.doesNotMatch(digest, /sk-abcdefghijklmnopqrstuvwxyz0123456789/)
  return true
})

await check('snapshot sync is idempotent and traces failures', async () => {
  const store = createEvalStore(join(dir, 'snap.sqlite'))
  const first = store.syncSnapshot(SNAPSHOT)
  const second = store.syncSnapshot(SNAPSHOT)
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.run.id, first.run.id)
  const findings = store.listOpenFindings()
  assert.equal(findings.length, 1)
  assert.equal(findings[0].taskId, 'svc-inspect-ports')
  assert.equal(findings[0].runId, first.run.id)
  assert.match(findings[0].detailDigest, /^sha256:/)
  store.close()
  return true
})

await check('/eval run l2 executes once per bucket and records findings', async () => {
  const runner = makeRunner()
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0, runner })
  const actor = await pair(host)
  await say(host, '/eval run l2')
  // 第二方法用不同大小写，避免 identical-message 去重，同时命中同一 5 分钟桶。
  await say(host, '/eval run L2')
  assert.equal(runner.state.calls, 1)
  await host.drainEval()
  await host.pump()

  const runs = evalStore.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.equal(runs[0].passed, 13)
  assert.equal(runs[0].total, 14)
  assert.equal(runs[0].triggeredBy, actor.id)
  assert.equal(runs[0].reportRef, '.eval-runs/test-l2')
  const findings = evalStore.listFindings({ runId: runs[0].id })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].taskId, 'svc-inspect-ports')
  assert.equal(host.stores.tasks.listTasks().length, 0)

  const replied = texts(transport).join('\n')
  assert.match(replied, /已开始 L2 离线测评/)
  assert.match(replied, /不重复执行/)
  assert.match(replied, /测评完成/)
  assert.match(replied, /svc-inspect-ports/)
  host.close()
  evalStore.close()
  return true
})

await check('/eval run l2 without an engine is explicit', async () => {
  const runner = { available: false, async run() { throw new Error('no engine') } }
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0, runner })
  await pair(host)
  await say(host, '/eval run l2')
  const replied = texts(transport).at(-1) ?? ''
  const runs = evalStore.listRuns()
  host.close()
  evalStore.close()
  return replied.includes('测评引擎未部署') && runs.length === 0
})

await check('/eval run real never executes', async () => {
  const runner = makeRunner()
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0, runner })
  await pair(host)
  await say(host, '/eval run real')
  const replied = texts(transport).at(-1) ?? ''
  const runs = evalStore.listRuns()
  host.close()
  evalStore.close()
  return runner.state.calls === 0 && runs.length === 0 && replied.includes('CI/nightly')
})

// ---- P2-3 人工反馈与候选回流 -------------------------------------------------------

await check('flag writes a redacted finding and resolves by prefix', async () => {
  const store = createEvalStore(join(dir, 'flag.sqlite'))
  const { finding, flag } = store.recordFlag({
    messageId: 'om_ref',
    threadId: 'th1',
    reason: '回答泄漏 token sk-abcdefghijklmnopqrstuvwxyz0123456789',
  })
  assert.equal(finding.source, 'flag')
  assert.equal(finding.status, 'open')
  assert.equal(flag.messageId, 'om_ref')
  assert.match(finding.detailDigest, /^sha256:/)
  assert.match(finding.title, /^人工标记：/)
  assert.doesNotMatch(finding.title, /sk-abcdefghijklmnopqrstuvwxyz0123456789/)
  const resolved = store.resolveFinding(finding.id.slice(0, 8))
  assert.equal(resolved.finding?.id, finding.id)
  assert.equal(store.resolveFinding('nope-nope').error, 'not-found')
  const updated = store.setFindingStatus(finding.id, 'ignored')
  assert.equal(updated.status, 'ignored')
  store.close()
  return true
})

await check('/eval flag needs a quoted message and records a finding', async () => {
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  await say(host, '/eval flag 回答不对')
  assert.match(texts(transport).at(-1) ?? '', /请引用一条消息/)
  assert.equal(evalStore.listOpenFindings().length, 0)

  await say(host, '/eval flag 引用后回答不对', { replyToMsgId: 'om_target' })
  const open = evalStore.listOpenFindings()
  assert.equal(open.length, 1)
  assert.equal(open[0].source, 'flag')
  assert.match(texts(transport).at(-1) ?? '', /已记录 finding/)
  host.close()
  evalStore.close()
  return true
})

await check('/eval promote writes a contract-valid candidate and closes the finding', async () => {
  const stubRoot = makeStubEvalRoot('export function validateTask() { return [] }\n')
  const candidatesDir = join(dir, 'candidates')
  const promoter = createCandidatePromoter({ root: stubRoot, candidatesDir })
  assert.equal(promoter.available, true)
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0, promoter })
  await pair(host)
  await say(host, '/eval flag 监管口径答错', { replyToMsgId: 'om_ref' })
  const finding = evalStore.listOpenFindings()[0]
  const short = finding.id.slice(0, 8)

  await say(host, `/eval promote ${short}`)
  const file = join(candidatesDir, `${finding.id}.json`)
  assert.equal(existsSync(file), true)
  const task = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(task.id, `dsh-reg-${short}`)
  assert.equal(task.source, 'regression')
  assert.equal(task.split, 'dev')
  assert.ok(task.turns.length === 1)
  assert.equal(typeof task.expect, 'object')
  // 只落 candidates，不自动改任务集。
  assert.equal(existsSync(join(stubRoot, 'tasks')), false)

  const promoted = evalStore.resolveFinding(finding.id).finding
  assert.equal(promoted.status, 'promoted')
  assert.equal(promoted.promotedTaskId, task.id)
  assert.match(texts(transport).at(-1) ?? '', /契约校验通过/)
  assert.doesNotMatch(texts(transport).at(-1) ?? '', /\/home\//)
  host.close()
  evalStore.close()
  return true
})

await check('/eval promote refuses an invalid candidate', async () => {
  const stubRoot = makeStubEvalRoot("export function validateTask() { return ['id 不合规'] }\n")
  const promoter = createCandidatePromoter({ root: stubRoot, candidatesDir: join(dir, 'bad-candidates') })
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0, promoter })
  await pair(host)
  await say(host, '/eval flag 回答不对', { replyToMsgId: 'om_ref' })
  const finding = evalStore.listOpenFindings()[0]
  await say(host, `/eval promote ${finding.id.slice(0, 8)}`)
  assert.equal(existsSync(join(dir, 'bad-candidates', `${finding.id}.json`)), false)
  assert.equal(evalStore.resolveFinding(finding.id).finding.status, 'open')
  assert.match(texts(transport).at(-1) ?? '', /未生成候选/)
  host.close()
  evalStore.close()
  return true
})

await check('/eval ignore closes the finding and promote needs an engine', async () => {
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  await say(host, '/eval flag 回答不对', { replyToMsgId: 'om_ref' })
  const finding = evalStore.listOpenFindings()[0]
  const short = finding.id.slice(0, 8)

  await say(host, `/eval promote ${short}`)
  assert.match(texts(transport).at(-1) ?? '', /候选生成需要 AGENT_EVAL_ROOT/)
  assert.equal(evalStore.resolveFinding(finding.id).finding.status, 'open')

  await say(host, `/eval ignore #${short}`)
  assert.equal(evalStore.resolveFinding(finding.id).finding.status, 'ignored')
  assert.match(texts(transport).at(-1) ?? '', /已忽略 finding/)
  assert.equal(evalStore.listOpenFindings().length, 0)
  host.close()
  evalStore.close()
  return true
})

// ---- P2-4 硬门禁与周报 -----------------------------------------------------------

await check('snapshot hard gate blocks a failing gate', async () => {
  const stub = makeStubGateEngine()
  const out = join(dir, 'snap-hard.json')
  const runSnapshot = (env) => spawnSync(
    process.execPath,
    [join(root, 'scripts/eval/snapshot.mjs'), '--engine', stub, '--out', out],
    { env: { ...process.env, AGENT_EVAL_ROOT: stub, ...env }, encoding: 'utf8' },
  )

  const hard = runSnapshot({ EVAL_HARD_GATE: '1', STUB_GATE_OK: '0' })
  assert.equal(hard.status, 1)
  const hardSnapshot = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(hardSnapshot.advisory, false)
  assert.equal(hardSnapshot.gate.ok, false)

  const advisory = runSnapshot({ EVAL_HARD_GATE: '0', STUB_GATE_OK: '0' })
  assert.equal(advisory.status, 0)
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).advisory, true)

  const pass = runSnapshot({ EVAL_HARD_GATE: '1', STUB_GATE_OK: '1' })
  assert.equal(pass.status, 0)
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).gate.ok, true)
  return true
})

await check('weekly report summarizes runs and open findings', async () => {
  const store = createEvalStore(join(dir, 'weekly.sqlite'))
  const to = new Date('2026-11-25T12:00:00.000Z')
  const from = new Date(to.getTime() - 7 * 86_400_000)
  const at = (days) => new Date(to.getTime() - days * 86_400_000).toISOString()
  store.recordRun({ suite: 'l2', mode: 'l2', status: 'ok', passed: 5, total: 5, idempotencyKey: 'w-ok', startedAt: at(1) })
  store.recordRun({ suite: 'l2', mode: 'l2', status: 'failed', passed: 4, total: 5, idempotencyKey: 'w-fail', startedAt: at(2) })
  store.recordRun({ suite: 'l2', mode: 'l2', status: 'failed', passed: 0, total: 5, idempotencyKey: 'w-old', startedAt: at(30) })
  const { finding } = store.recordFlag({ messageId: 'om_weekly', reason: '回答不对' })

  const text = formatEvalWeekly({
    runs: store.listRuns({ limit: 100 }),
    findings: store.listOpenFindings(20),
    from,
    to,
  })
  assert.match(text, /run 2 · 通过 1 · 未通过\/超时 1 · 未处理 findings 1/)
  assert.match(text, new RegExp(`\\[${finding.id.slice(0, 8)}\\]`))
  assert.doesNotMatch(text, /om_weekly/)
  assert.equal(formatEvalWeekly({ runs: [], findings: [], from, to }), null)
  const countsText = formatEvalWeekly({
    runs: [],
    findings: [],
    from,
    to,
    statusCounts: { open: 0, promoted: 1, ignored: 0, verified: 2, regressed: 3 },
  })
  assert.match(countsText, /闭环：promoted 1 · verified 2 · regressed 3/)
  store.close()
  return true
})

await check('production trace export drops text, args and absolute paths', async () => {
  const base = join(dir, 'export')
  const sessionDir = join(base, 'sessions', '--proj--', 'session-prod')
  mkdirSync(sessionDir, { recursive: true })
  const events = [
    { type: 'session', data: { id: 'session-prod' } },
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '看下服务，password=supersecretvalue' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'tool-call', id: 'c1', name: 'svc_list', arguments: '{}' }] } },
    },
    { type: 'tool/call', data: { callId: 'c1', name: 'svc_list', arguments: '{}' } },
    {
      type: 'tool/result',
      data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'secret /home/ailearn/x' }] } },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: '服务正常，配置在 /home/ailearn/projects/dsh-wfxm/.env，token=ghp_abcdefghijklmnopqrstuvwxyz0123' },
          ],
        },
      },
    },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  writeFileSync(
    join(sessionDir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)),
  )

  const outDir = join(base, 'eval', 'trajectory')
  execFileSync(process.execPath, [
    join(root, 'scripts/eval/export-traces.mjs'),
    '--source', join(base, 'sessions'),
    '--out', outDir,
    '--repo-root', base,
    '--label', 'test',
  ], { encoding: 'utf8' })

  const files = readdirSync(outDir)
  const traceName = files.find((name) => name.endsWith('.ndjson'))
  const taskName = files.find((name) => name.endsWith('.json'))
  assert.ok(traceName !== undefined && taskName !== undefined)
  const trace = readFileSync(join(outDir, traceName), 'utf8')
  const task = JSON.parse(readFileSync(join(outDir, taskName), 'utf8'))

  assert.match(trace, /"type":"tool_call","name":"svc_list"/)
  assert.match(trace, /<path>/)
  assert.match(trace, /\[redacted:github-token:\d+\]/)
  assert.doesNotMatch(trace, /supersecretvalue|ghp_abcdefghijklmnopqrstuvwxyz0123|ailearn|\/home\/|内部推理|session-prod/)
  assert.deepEqual(task.expect.requiredTools, ['svc_list'])
  assert.deepEqual(task.turns, ['（生产轨迹回放）'])
  assert.match(task.runtimeHints.dsh.traceFile, /^eval\/trajectory\/dsh-test-[0-9a-f]{8}\.ndjson$/)
  return true
})

// ---- P7-1 生产失败回流 ------------------------------------------------------------

await check('production finding is recorded once per task', async () => {
  const store = createEvalStore(join(dir, 'production.sqlite'))
  const first = store.recordProductionFinding({
    taskId: 'nhdn6m3wuh', title: '生产失败：nhdn6m3wuh', detail: 'eval/candidates/x.ndjson',
  })
  const second = store.recordProductionFinding({
    taskId: 'nhdn6m3wuh', title: '生产失败：nhdn6m3wuh',
  })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.finding.id, first.finding.id)
  assert.equal(first.finding.suite, 'production')
  assert.equal(first.finding.status, 'open')
  store.close()
  return true
})

await check('/eval from-task turns a failed task into a redacted candidate', async () => {
  const candidatesDir = join(dir, 'eval', 'candidates')
  const events = [
    { ts: '2026-11-24T09:59:00.000Z', event: 'tool.call', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: null } },
    { ts: '2026-11-24T09:59:20.000Z', event: 'tool.result', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: 0 } },
    { ts: '2026-11-24T09:59:30.000Z', event: 'attempt.finished', level: 'error', phase: 'execute', status: 'failed', error: { code: 'verification-failed', kind: 'failed' }, tool: null },
  ]
  const fake = makeFakeTelemetry({})
  const { host, transport, evalStore } = makeHost(
    { snapshotPath, rateLimitMs: 0, fromTask: { candidatesDir, root: dir } },
    fake,
  )
  await pair(host)
  const task = host.stores.tasks.createTask({
    intent: '列出受管服务', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-prod-fail',
  })
  host.stores.tasks.claimTask({ owner: 'test', leaseMs: 60_000, taskId: task.id })
  host.stores.tasks.transition(task.id, { to: 'failed', summary: '验证失败', reason: 'test' })
  fake.query = (input) => {
    const rows = input.taskId === task.id ? events : []
    return { rows, count: rows.length }
  }
  fake.attempts = (taskId) => (taskId === task.id
    ? [{ summary: '看下 /home/ailearn/x，token=ghp_abcdefghijklmnopqrstuvwxyz0123' }]
    : [])

  await say(host, `/eval from-task ${task.taskRef ?? task.id}`)
  const replied = texts(transport).at(-1) ?? ''
  assert.match(replied, /已回流任务/)
  assert.match(replied, /promoted/)
  assert.doesNotMatch(replied, /\/home\/|ghp_abcdefghijklmnopqrstuvwxyz0123/)

  const files = readdirSync(candidatesDir)
  const traceName = files.find((name) => name.endsWith('.ndjson'))
  const taskName = files.find((name) => name.endsWith('.json'))
  assert.ok(traceName !== undefined && taskName !== undefined)
  const trace = readFileSync(join(candidatesDir, traceName), 'utf8')
  const draft = JSON.parse(readFileSync(join(candidatesDir, taskName), 'utf8'))
  assert.match(trace, /"type":"tool_call","name":"svc_list"/)
  assert.match(trace, /"phase":"turn_end"/)
  assert.doesNotMatch(trace, /ailearn|\/home\/|ghp_abcdefghijklmnopqrstuvwxyz0123/)
  assert.deepEqual(draft.expect.requiredTools, ['svc_list'])
  assert.match(draft.runtimeHints.dsh.traceFile, /^eval\/candidates\/dsh-prod-[0-9a-f]{8}\.ndjson$/)

  const findings = evalStore.listFindings({ status: 'promoted' })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].suite, 'production')
  assert.equal(findings[0].taskId, task.id)
  assert.equal(findings[0].promotedTaskId, draft.id)

  // 第二次不再落盘；非失败任务与未知任务都不生成候选。
  await say(host, `/eval FROM-TASK ${task.taskRef ?? task.id}`)
  assert.match(texts(transport).at(-1) ?? '', /候选已存在/)
  const running = host.stores.tasks.createTask({
    intent: '还在跑', riskLevel: 'R1', maxAttempts: 1, correlationId: 'trace-prod-open',
  })
  await say(host, `/eval from-task ${running.taskRef ?? running.id}`)
  assert.match(texts(transport).at(-1) ?? '', /只有失败任务可回流/)
  await say(host, '/eval from-task nosuchtask')
  assert.match(texts(transport).at(-1) ?? '', /找不到任务/)
  host.close()
  evalStore.close()
  return true
})

await check('/eval refresh overwrites the candidate with the fix task trace', async () => {
  const candidatesDir = join(dir, 'eval-refresh', 'candidates')
  const fake = makeFakeTelemetry({})
  const { host, transport, evalStore } = makeHost(
    { snapshotPath, rateLimitMs: 0, fromTask: { candidatesDir, root: dir } },
    fake,
  )
  await pair(host)
  const failEvents = [
    { ts: '2026-11-24T09:59:00.000Z', event: 'tool.call', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: null } },
    { ts: '2026-11-24T09:59:30.000Z', event: 'attempt.finished', level: 'error', phase: 'execute', status: 'failed', error: { code: 'verification-failed', kind: 'failed' }, tool: null },
  ]
  const task = host.stores.tasks.createTask({
    intent: '列出受管服务', riskLevel: 'R1', maxAttempts: 1, correlationId: 'refresh-fail',
  })
  host.stores.tasks.claimTask({ owner: 'test', leaseMs: 60_000, taskId: task.id })
  host.stores.tasks.transition(task.id, { to: 'failed', summary: '验证失败', reason: 'test' })
  fake.query = (input) => {
    const rows = input.taskId === task.id ? failEvents : []
    return { rows, count: rows.length }
  }
  fake.attempts = (taskId) => (taskId === task.id ? [{ summary: '缺文件' }] : [])

  await say(host, `/eval from-task ${task.taskRef ?? task.id}`)
  const finding = evalStore.listFindings({ status: 'promoted' })[0]
  assert.ok(finding !== undefined)
  const short = finding.id.slice(0, 8)
  const tracePath = join(candidatesDir, `${finding.promotedTaskId}.ndjson`)
  const draftPath = join(candidatesDir, `${finding.promotedTaskId}.json`)
  const traceBefore = readFileSync(tracePath, 'utf8')
  const draftBefore = readFileSync(draftPath, 'utf8')

  // 还没有修复任务。
  await say(host, `/eval refresh ${short}`)
  assert.match(texts(transport).at(-1) ?? '', /还没有修复任务/)

  // 修复任务存在但未成功：拒绝刷新，旧证据不动。
  await say(host, `/eval fix ${short}`)
  const fixTask = host.stores.tasks.listTasks().find((item) => item.intent.includes('修复测评失败'))
  assert.ok(fixTask !== undefined)
  // 网关对 60 秒内同文案判重，这里换一种 ref 写法避免被当成重复消息。
  await say(host, `/eval refresh ${finding.id}`)
  assert.match(texts(transport).at(-1) ?? '', /只有成功的修复任务/)
  assert.equal(readFileSync(tracePath, 'utf8'), traceBefore)
  assert.equal(readFileSync(draftPath, 'utf8'), draftBefore)

  // 成功的修复轨迹：轨迹被替换，草稿与判据保持原样，不新增候选。
  const okEvents = [
    { ts: '2026-11-24T10:00:00.000Z', event: 'tool.call', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: null } },
    { ts: '2026-11-24T10:00:10.000Z', event: 'tool.result', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: 0 } },
    { ts: '2026-11-24T10:00:20.000Z', event: 'executor.step', level: 'info', phase: 'execute', status: 'ok', error: null, tool: null },
  ]
  fake.query = (input) => {
    const rows = input.taskId === fixTask.id ? okEvents : (input.taskId === task.id ? failEvents : [])
    return { rows, count: rows.length }
  }
  fake.attempts = (taskId) => {
    if (taskId === fixTask.id) return [{ summary: '已修复' }]
    return taskId === task.id ? [{ summary: '缺文件' }] : []
  }
  host.stores.tasks.claimTask({ owner: 'test', leaseMs: 60_000, taskId: fixTask.id })
  host.stores.tasks.transition(fixTask.id, { to: 'succeeded', summary: '修复完成' })

  await say(host, `/eval refresh #${short}`)
  assert.ok(
    texts(transport).some((text) => /已用修复任务 .* 的成功轨迹刷新候选/.test(text)),
    `refresh reply missing: ${texts(transport).slice(-3).join(' | ')}`,
  )
  const traceAfter = readFileSync(tracePath, 'utf8')
  assert.notEqual(traceAfter, traceBefore)
  assert.match(traceAfter, /"name":"svc_list"/)
  assert.doesNotMatch(traceAfter, /turn_end/)
  assert.equal(readFileSync(draftPath, 'utf8'), draftBefore)
  assert.equal(readdirSync(candidatesDir).filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(evalStore.resolveFinding(finding.id).finding.status, 'promoted')

  // 已验证的 finding 无需刷新（换写法避开同文案判重）。
  evalStore.setFindingStatus(finding.id, 'verified')
  await say(host, `/eval refresh #${finding.id}`)
  assert.match(texts(transport).at(-1) ?? '', /已验证通过，无需刷新候选/)

  host.close()
  evalStore.close()
  return true
})

await check('/eval refresh refuses a trace missing the candidate tools', async () => {
  const candidatesDir = join(dir, 'eval-refresh-tools', 'candidates')
  mkdirSync(candidatesDir, { recursive: true })
  const candidateId = 'dsh-prod-00000001'
  writeFileSync(join(candidatesDir, `${candidateId}.json`), `${JSON.stringify({
    id: candidateId,
    kind: 'chat',
    turns: ['x'],
    expect: { requiredTools: ['write'] },
    runtimeHints: { dsh: { traceFile: 'eval/candidates/x.ndjson' } },
  })}\n`)
  writeFileSync(join(candidatesDir, `${candidateId}.ndjson`), `${JSON.stringify({ type: 'session', sessionId: 'old' })}\n`)

  const fake = makeFakeTelemetry({})
  const { host, transport, evalStore } = makeHost(
    { snapshotPath, rateLimitMs: 0, fromTask: { candidatesDir, root: dir } },
    fake,
  )
  await pair(host)
  const { finding } = evalStore.recordProductionFinding({ taskId: 'nrefresh03', title: '生产失败：nrefresh03' })
  evalStore.setFindingStatus(finding.id, 'promoted', candidateId)
  const fixTask = host.stores.tasks.createTask({ intent: '修复测评失败：x', riskLevel: 'R1', maxAttempts: 1 })
  host.stores.tasks.claimTask({ owner: 'test', leaseMs: 60_000, taskId: fixTask.id })
  host.stores.tasks.transition(fixTask.id, { to: 'succeeded', summary: 'ok' })
  evalStore.setFindingFixTask(finding.id, fixTask.id)
  fake.query = () => ({
    rows: [{ ts: '2026-11-24T10:00:00.000Z', event: 'tool.call', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: null } }],
    count: 1,
  })
  fake.attempts = () => []

  await say(host, `/eval refresh ${finding.id.slice(0, 8)}`)
  assert.match(texts(transport).at(-1) ?? '', /缺少候选判据要求的工具/)
  assert.match(readFileSync(join(candidatesDir, `${candidateId}.ndjson`), 'utf8'), /"sessionId":"old"/)
  host.close()
  evalStore.close()
  return true
})

await check('/eval fix links a finding to one fix task', async () => {
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  const { finding } = evalStore.recordProductionFinding({
    taskId: 'nfix01',
    title: '生产失败：nfix01',
    detail: 'eval/candidates/x.ndjson',
  })
  const short = finding.id.slice(0, 8)

  await say(host, `/eval fix ${short}`)
  assert.match(texts(transport).at(-1) ?? '', /已建修复任务/)
  const fixTask = host.stores.tasks.listTasks().find((task) => task.intent.includes('修复测评失败'))
  assert.ok(fixTask !== undefined)
  assert.equal(fixTask.riskLevel, 'R1')
  assert.equal(evalStore.resolveFinding(finding.id).finding.fixTaskId, fixTask.id)

  // findings 列表带出修复任务短 id，处理提示包含 /eval fix。
  await say(host, '/eval findings')
  const listed = texts(transport).at(-1) ?? ''
  assert.match(listed, new RegExp(`修复 ${fixTask.id.slice(0, 8)}`))
  assert.match(listed, /\/eval fix <id>/)

  // 同一个 finding 不重复建任务。
  const before = host.stores.tasks.listTasks().length
  await say(host, `/eval fix ${short}`)
  assert.match(texts(transport).at(-1) ?? '', /已有修复任务/)
  assert.equal(host.stores.tasks.listTasks().length, before)

  // 已忽略的 finding 不建任务。
  const ignored = evalStore.recordProductionFinding({ taskId: 'nfix02', title: '生产失败：nfix02' }).finding
  evalStore.setFindingStatus(ignored.id, 'ignored')
  await say(host, `/eval fix ${ignored.id.slice(0, 8)}`)
  assert.match(texts(transport).at(-1) ?? '', /已忽略/)

  // 关联任务已不存在（被清理）时允许重建。
  const retry = evalStore.recordProductionFinding({ taskId: 'nfix03', title: '生产失败：nfix03' }).finding
  evalStore.setFindingFixTask(retry.id, 'gone-task')
  await say(host, `/eval fix ${retry.id.slice(0, 8)}`)
  assert.match(texts(transport).at(-1) ?? '', /已建修复任务/)
  assert.notEqual(evalStore.resolveFinding(retry.id).finding.fixTaskId, 'gone-task')

  host.close()
  evalStore.close()
  return true
})

await check('/eval commands are not swallowed by a live task thread', async () => {
  const { host, transport, evalStore } = makeHost({ snapshotPath, rateLimitMs: 0 })
  await pair(host)
  const { finding } = evalStore.recordProductionFinding({
    taskId: 'nfix04',
    title: '生产失败：nfix04',
  })
  // 把一条 queued 任务绑成线程的 live default owner：网关随后会把消息标成 attach，
  // host 仍须按文本识别 /eval，否则命令会被任务补料吞掉。
  const { result } = await say(host, '/eval findings')
  const live = host.stores.tasks.createTask({
    intent: '占住线程',
    riskLevel: 'R1',
    maxAttempts: 1,
    correlationId: 'hold-thread',
  })
  host.stores.tasks.bindThread({
    taskId: live.id,
    threadId: result.result.thread.id,
    relation: 'default_owner',
    anchorMsgId: 'hold-anchor',
  })

  await say(host, `/eval fix ${finding.id.slice(0, 8)}`)
  assert.match(texts(transport).at(-1) ?? '', /已建修复任务/)
  assert.notEqual(evalStore.resolveFinding(finding.id).finding.fixTaskId, null)

  host.close()
  evalStore.close()
  return true
})

await check('weekly report shows the production backlog', async () => {
  const to = new Date('2026-11-25T12:00:00.000Z')
  const from = new Date(to.getTime() - 7 * 86_400_000)
  const text = formatEvalWeekly({ runs: [], findings: [], from, to, productionBacklog: 2 })
  assert.match(text, /可回流失败 2 条/)
  assert.match(text, /from-task/)
  return true
})

await check('nightly eval writes runs and findings to the eval DB', async () => {
  const stub = makeStubGateEngine()
  const db = join(dir, 'nightly.sqlite')
  const out = join(dir, 'nightly-latest.json')
  const env = { ...process.env, STUB_GATE_OK: '0' }
  delete env.LD_LIBRARY_PATH
  const run = spawnSync(process.execPath, [
    join(root, 'scripts/eval/nightly.mjs'),
    '--engine', stub,
    '--db', db,
    '--out', out,
    '--candidates', join(dir, 'nightly-candidates'),
    '--staging', join(dir, 'nightly-staging'),
  ], { env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /nightly eval: run /)

  const store = createEvalStore(db)
  const runs = store.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.equal(runs[0].mode, 'snapshot')
  assert.equal(runs[0].passed, 5)
  assert.equal(runs[0].total, 6)
  const findings = store.listFindings({ runId: runs[0].id })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].suite, 'smoke')
  store.close()

  // 第二天再跑：run 继续累积，但同一 suite+task 的 open finding 不重复登记。
  const again = spawnSync(process.execPath, [
    join(root, 'scripts/eval/nightly.mjs'),
    '--engine', stub,
    '--db', db,
    '--out', out,
    '--candidates', join(dir, 'nightly-candidates'),
    '--staging', join(dir, 'nightly-staging'),
  ], { env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(again.status, 0, again.stderr)
  const store2 = createEvalStore(db)
  assert.equal(store2.listRuns().length, 2)
  assert.equal(store2.listFindings({ limit: 10 }).length, 1)
  store2.close()
  return true
})

// ---- P7-4 回放闭环 ----------------------------------------------------------------

await check('replay outcomes move a finding promoted → verified → regressed', async () => {
  const store = createEvalStore(join(dir, 'replay-store.sqlite'))
  const { finding } = store.recordProductionFinding({ taskId: 'prod-replay', title: '生产失败：prod-replay' })
  store.setFindingStatus(finding.id, 'promoted', 'dsh-prod-replay01')

  // 首次回放失败 = 原失败仍复现，保持 promoted，不算回归。
  let tally = store.recordReplays([{ taskId: 'dsh-prod-replay01', passed: false }])
  assert.deepEqual(tally, { verified: 0, regressed: 0, failed: 1, skipped: 0 })
  assert.equal(store.listFindings({ limit: 5 })[0].status, 'promoted')

  tally = store.recordReplays([{ taskId: 'dsh-prod-replay01', passed: true }])
  assert.deepEqual(tally, { verified: 1, regressed: 0, failed: 0, skipped: 0 })
  let row = store.listFindings({ limit: 5 })[0]
  assert.equal(row.status, 'verified')
  assert.ok(typeof row.verifiedAt === 'string')
  // 同一结论重复回放不重复计数。
  tally = store.recordReplays([{ taskId: 'dsh-prod-replay01', passed: true }])
  assert.deepEqual(tally, { verified: 0, regressed: 0, failed: 0, skipped: 0 })

  tally = store.recordReplays([{ taskId: 'dsh-prod-replay01', passed: false }])
  assert.deepEqual(tally, { verified: 0, regressed: 1, failed: 0, skipped: 0 })
  row = store.listFindings({ limit: 5 })[0]
  assert.equal(row.status, 'regressed')
  assert.equal(row.verifiedAt, null)
  assert.ok(typeof row.regressedAt === 'string')

  tally = store.recordReplays([{ taskId: 'dsh-prod-replay01', passed: true }])
  assert.equal(tally.verified, 1)
  assert.equal(store.listFindings({ limit: 5 })[0].status, 'verified')

  assert.equal(store.recordReplays([{ taskId: 'no-such-candidate', passed: true }]).skipped, 1)
  assert.equal(store.countFindingsByStatus().verified, 1)
  store.close()
  return true
})

await check('nightly stages promoted candidates and records replay results', async () => {
  const stub = makeStubGateEngine()
  const candidatesDir = join(dir, 'replay-candidates')
  const stagingDir = join(dir, 'replay-staging')
  const task = { id: 'prod-task-7', taskRef: 'prod-task-7', correlationId: 'corr-7' }
  const candidate = createTrajectoryCandidate({
    task,
    events: [
      { ts: '2026-11-24T10:00:00.000Z', event: 'tool.call', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: null } },
      { ts: '2026-11-24T10:00:10.000Z', event: 'tool.result', level: 'info', phase: 'execute', status: 'ok', error: null, tool: { name: 'svc_list', exitCode: 0 } },
    ],
    attempts: [],
    outDir: candidatesDir,
    root: dir,
    label: 'prod',
  })
  assert.equal(candidate.ok, true)

  const db = join(dir, 'replay-nightly.sqlite')
  const out = join(dir, 'replay-latest.json')
  const seed = createEvalStore(db)
  const { finding } = seed.recordProductionFinding({ taskId: task.id, title: '生产失败：prod-task-7' })
  seed.setFindingStatus(finding.id, 'promoted', candidate.id)
  seed.close()

  const runNightly = (pass) => {
    const env = {
      ...process.env,
      STUB_GATE_OK: '1',
      STUB_TRAJECTORY: '1',
      STUB_TRAJECTORY_PASS: pass ? '1' : '0',
    }
    delete env.LD_LIBRARY_PATH
    return spawnSync(process.execPath, [
      join(root, 'scripts/eval/nightly.mjs'),
      '--engine', stub,
      '--db', db,
      '--out', out,
      '--candidates', candidatesDir,
      '--staging', stagingDir,
    ], { env, encoding: 'utf8', timeout: 120_000 })
  }

  const pass = runNightly(true)
  assert.equal(pass.status, 0, pass.stderr)
  assert.match(pass.stdout, /candidates staged 1/)
  assert.match(pass.stdout, /replay verified 1 regressed 0/)
  const snapshot = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(snapshot.trajectory.length, 1)
  assert.equal(snapshot.trajectory[0].taskId, candidate.id)
  assert.equal(snapshot.trajectory[0].passed, true)
  const staged = JSON.parse(readFileSync(join(stagingDir, `${candidate.id}.json`), 'utf8'))
  assert.ok(Array.isArray(staged.runtimeHints.dsh.events))
  assert.equal(staged.runtimeHints.dsh.traceFile, undefined)

  let store = createEvalStore(db)
  assert.equal(store.listFindings({ limit: 5 })[0].status, 'verified')
  store.close()

  const fail = runNightly(false)
  assert.equal(fail.status, 0, fail.stderr)
  assert.match(fail.stdout, /replay verified 0 regressed 1/)
  store = createEvalStore(db)
  const row = store.listFindings({ limit: 5 })[0]
  assert.equal(row.status, 'regressed')
  assert.ok(typeof row.regressedAt === 'string')
  store.close()
  return true
})

rmSync(dir, { recursive: true, force: true })

console.log(`\neval-loop: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
