/**
 * Live end-to-end verification without a human on the phone.
 *
 * Inbound is injected (the channel's normalization is covered by plugins/feishu's
 * own tests and the one real round-trip already recorded); everything else is
 * real: ① ingest → foreground → ⑤ worker → executor → Verifier → ack/receipt →
 * ① outbox → Feishu API. So the proof this script prints is "a real message id
 * came back from Feishu", not a mock.
 *
 *   node scripts/verify-live.mjs            # stub executor (fast)
 *   node scripts/verify-live.mjs --dsh      # real dsh headless
 *
 * Self-contained: it creates its own test owner/binding in an isolated DB, so
 * no /bind and no typing needed. The only real-world input is the chat id that
 * outbound lands in (`DSH_WFXM_CHAT`).
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { createGatewayStore } from '@dsh-wfxm/gateway'
import { createGrantStore } from '@dsh-wfxm/governance'
import { createDshExecutor } from '@dsh-wfxm/executor'
import {
  createFeishuTransport,
  createLarkClient,
  loadFeishuCredentials,
} from '@dsh-wfxm/feishu'
import { createWfxmHost } from '@dsh-wfxm/host'

delete process.env.LD_LIBRARY_PATH

const dbPath = process.env.DSH_WFXM_LIVE_DB ?? '.wfxm/live/ops.sqlite'
process.env.DSH_WFXM_DB ??= dbPath
const grantsPath = process.env.DSH_WFXM_LIVE_GRANTS ?? '.wfxm/live/grants.sqlite'
const workdir = process.env.DSH_WFXM_LIVE_WORKDIR ?? '.wfxm/live/workspace'
const useDsh = process.argv.includes('--dsh')
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(dirname(grantsPath), { recursive: true })
mkdirSync(workdir, { recursive: true })
if (process.env.DSH_WFXM_LIVE_KEEP !== '1') {
  for (const file of [dbPath, grantsPath]) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
  }
}

let passed = 0
let failed = 0
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
function assert(ok, message) {
  if (!ok) throw new Error(message)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const credentials = loadFeishuCredentials({
  ...process.env.DSH_WFXM_FEISHU_CONFIG === undefined
    ? {}
    : { configPath: process.env.DSH_WFXM_FEISHU_CONFIG },
  ...process.env.DSH_WFXM_CREDENTIALS === undefined
    ? {}
    : { credentialsPath: process.env.DSH_WFXM_CREDENTIALS },
})
const client = await createLarkClient({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  ...credentials.domain === null ? {} : { domain: credentials.domain },
})

// Inbound identity is ours to create (a fresh DB binds its own test owner); the
// chat id is the one real-world input, because outbound must land somewhere real.
const gw = createGatewayStore(dbPath)
if (gw.listBindings().length === 0) {
  const actor = gw.createActor({ kind: 'owner', displayName: 'live-tester' })
  gw.bindChannel({
    actorId: actor.id,
    channelId: credentials.appId,
    externalUserId: 'ou_live_tester',
  })
}
const binding = gw.listBindings()[0]
const externalUserId = binding.externalUserId
const chatId = process.env.DSH_WFXM_CHAT ?? 'oc_6e9ec1eb6ecc6defad3058aecdd53df8'
const channelId = binding.channelId
gw.close()

let host = null
const transport = createFeishuTransport({
  client,
  resolveChatId: (threadId) => host?.stores.gateway.getThread(threadId)?.chatId ?? null,
  logger: { info: () => {}, warn: (m, meta) => console.log('transport:warn', m, meta ?? '') },
})

const executor = useDsh
  ? createDshExecutor({ env: { ...process.env }, defaultWorkdir: workdir, timeoutMs: 180_000 })
  : async () => ({ status: 'succeeded', summary: 'stub executor: 链路通了' })

const grants = createGrantStore(grantsPath)
host = createWfxmHost({
  dbPath,
  executor,
  transport,
  grants,
  worker: { verify: { cwd: workdir } },
  logger: { warn: (m) => console.log('host:warn', m) },
})

let seq = 0
const nextMsgId = (prefix) => {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function send(text, options = {}) {
  return host.ingest({
    channelId,
    msgId: options.msgId ?? nextMsgId('live'),
    externalUserId: options.externalUserId ?? externalUserId,
    kind: 'message',
    content: {
      text,
      ...options.externalMsgId === undefined ? {} : { externalMsgId: options.externalMsgId },
    },
    chatId,
    ...options.replyToMsgId === undefined ? {} : { replyToMsgId: options.replyToMsgId },
  })
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    const report = await host.runWorkerOnce()
    if (report.skipped === 'idle') break
  }
  let pumped = await host.pump()
  for (let i = 0; i < 10 && (pumped.dispatch?.sent ?? 0) > 0; i += 1) pumped = await host.pump()
  return pumped
}

const outboxFor = (taskId) => host.stores.gateway.listOutbox().filter((item) => {
  const payload = item.payload
  return item.taskId === taskId
    || (typeof payload === 'object' && payload !== null && payload.taskId === taskId)
})

// ---- 1. 未配对身份：静默拒绝，零出站 ------------------------------------------------

await check('未配对身份被拒绝且不产生任何出站', async () => {
  const before = host.stores.gateway.listOutbox().length
  const turn = await send('陌生人消息', { externalUserId: 'ou_stranger_live' })
  const after = host.stores.gateway.listOutbox().length
  assert(turn.result.bypassReason === 'unpaired', `bypass=${turn.result.bypassReason}`)
  assert(after === before, `outbox 增加了 ${after - before} 条`)
})

// ---- 2. 真实回执：ack + 终态回执都经飞书 API 发出（拿到真实 message_id） ---------------

let taskId = null
let receiptMsgId = null
await check('建任务即回 ack，且经飞书 API 真实送达', async () => {
  const turn = await send('看看磁盘占用（自动化验证）')
  assert(turn.foreground?.action === 'task-created', `foreground=${JSON.stringify(turn.foreground)}`)
  taskId = turn.foreground.taskId
  const pumped = await host.pump()
  assert((pumped.dispatch?.sent ?? 0) >= 1, `dispatch.sent=${pumped.dispatch?.sent}`)
  const ack = host.stores.gateway.listOutbox().find((item) =>
    item.topic === 'say' && item.externalMsgId !== null)
  assert(ack !== undefined, '没有送达的 ack 行')
  return `ack message_id=${ack.externalMsgId}`
})

await check('worker 执行后回执经飞书 API 真实送达，并回填 receipts', async () => {
  await settle()
  const task = host.stores.tasks.getTask(taskId)
  assert(task?.status === 'succeeded', `task.status=${task?.status}`)
  const receipts = host.stores.tasks.listReceipts(taskId)
  assert(receipts.length === 1, `receipts=${receipts.length}`)
  assert(receipts[0].deliveredAt !== null, 'receipt 未送达')
  receiptMsgId = receipts[0].externalMsgId
  assert(typeof receiptMsgId === 'string' && receiptMsgId.startsWith('om_'), `externalMsgId=${receiptMsgId}`)
  const rows = host.stores.gateway.listOutbox({ status: 'sent' })
    .filter((item) => item.topic === 'task.receipt' && item.taskId === taskId)
  assert(rows.length === 1, `回执行=${rows.length}`)
  return `receipt message_id=${receiptMsgId}`
})

// ---- 3. #10 锚点 + AR37：有授权时回复回执唤醒进入第二轮，第二轮回执真实送达 ------------

let round2ReceiptMsgId = null
await check('授予 task.wake 后回复回执命中锚点，唤醒进入 round 2 并真实送达回执', async () => {
  grants.create({ actorId: binding.actorId, scope: { actions: ['task.wake'] }, kind: 'forever' })
  const turn = await send('继续，再说一句', { replyToMsgId: receiptMsgId })
  assert(turn.result.followUp?.matchedBy === 'anchor', `matchedBy=${turn.result.followUp?.matchedBy}`)
  assert(turn.result.followUp?.taskId === taskId, `taskId=${turn.result.followUp?.taskId}`)
  assert(turn.result.wake?.woken === true, `wake=${JSON.stringify(turn.result.wake)}`)
  const woken = host.stores.tasks.getTask(taskId)
  assert(woken?.round === 2, `round=${woken?.round}`)
  await settle()
  const receipts = host.stores.tasks.listReceipts(taskId).filter((item) => item.round === 2)
  assert(receipts.length === 1, `round2 receipts=${receipts.length}`)
  assert(receipts[0].deliveredAt !== null, 'round2 回执未送达')
  round2ReceiptMsgId = receipts[0].externalMsgId
  return `round2 message_id=${round2ReceiptMsgId}`
})

// ---- 4. 撤权后同一锚点不再唤醒（AR37 fail-closed） -----------------------------------

await check('撤销授权后回复锚点不再唤醒，任务停在 round 2', async () => {
  grants.revokeAll()
  const turn = await send('再跑一轮', { replyToMsgId: round2ReceiptMsgId })
  assert(turn.result.followUp?.matchedBy === 'anchor', `matchedBy=${turn.result.followUp?.matchedBy}`)
  assert(turn.result.wake?.granted === false, `wake=${JSON.stringify(turn.result.wake)}`)
  const task = host.stores.tasks.getTask(taskId)
  assert(task?.round === 2, `round=${task?.round}`)
  return `wake.reason=${turn.result.wake?.reason}`
})

// ---- 5. 幂等：同一 msgId 重放不新建任务、不重复出站 -----------------------------------

await check('同一 msgId 重放被去重，且 ack 真的回在用户那条消息上', async () => {
  await settle() // 上一步落到前台的那条排队任务先跑完，否则本轮只会入队、不会建新任务
  const msgId = nextMsgId('dup')
  // 带上真实的 om_ id：证明 ack 用的是渠道消息 id，而不是事件 id（飞书 99992354 那个坑）
  const first = await send('幂等验证', { msgId, externalMsgId: receiptMsgId })
  const tasksBefore = host.stores.tasks.listTasks().length
  const outboxBefore = host.stores.gateway.listOutbox().length
  const again = await send('幂等验证', { msgId })
  assert(first.result.duplicate !== true, '首条被判重复')
  assert(again.result.duplicate === true, '重放未被去重')
  assert(host.stores.tasks.listTasks().length === tasksBefore, '任务数变化')
  assert(host.stores.gateway.listOutbox().length === outboxBefore, '出站数变化')
  const ack = host.stores.gateway.listOutbox({ status: 'pending' })
    .find((item) => item.replyToMsgId === receiptMsgId)
  assert(ack !== undefined, 'ack 没有回在用户消息上')
  await host.pump()
  const sent = host.stores.gateway.listOutbox({ status: 'sent' })
    .find((item) => item.id === ack.id)
  assert(sent?.externalMsgId?.startsWith('om_') === true, `ack externalMsgId=${sent?.externalMsgId}`)
  return `ack 回复 ${receiptMsgId} 成功 → ${sent.externalMsgId}`
})

await sleep(200)
console.log(`\n通过 ${passed}，失败 ${failed}（db=${dbPath}, executor=${useDsh ? 'dsh' : 'stub'}）`)
host.close()
grants.close()
process.exit(failed === 0 ? 0 : 1)
