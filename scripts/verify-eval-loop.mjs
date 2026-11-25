/**
 * P2-1 `/eval` 只读闭环验收：命令解析、快照读取、owner 限流、host 回执。
 *
 * 无网络、无模型、无 dsh；用真实 SQLite + 假 transport，验证的是接线本身。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const { createEvalStore, digestText } = await import('../plugins/eval/lib/index.js')
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

function makeHost(evalOptions) {
  hostSeq += 1
  const dbPath = join(dir, `host-${hostSeq}.sqlite`)
  const evalStore = createEvalStore(dbPath)
  const transport = makeTransport()
  const host = createWfxmHost({
    dbPath,
    executor: () => ({ status: 'succeeded', summary: 'executor ok' }),
    transport,
    now,
    eval: evalOptions === null ? null : { store: evalStore, ...(evalOptions ?? {}) },
  })
  return { host, transport, evalStore }
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

async function say(host, text) {
  const msgId = uniqueMsg()
  const result = await host.ingest({
    channelId: CHANNEL,
    msgId,
    externalUserId: 'ou_owner',
    content: { text },
    chatId: CHAT,
  })
  await host.pump()
  return { result, msgId }
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

rmSync(dir, { recursive: true, force: true })

console.log(`\neval-loop: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
