/**
 * Hermetic end-to-end acceptance for @dsh-wfxm/host (切片 C).
 *
 * No network, no model, no dsh process: a fake transport, a stub executor and
 * real SQLite. What is proven here is the wiring itself — 飞书-shaped inbound →
 * ① ingest → foreground → ⑤ worker → Verifier → receipt → ① outbox → transport,
 * plus the two closing loops (#10 reply-to-receipt, AR37 wake) and the
 * fail-closed paths (#6 unpaired, #11 foreground never executes, AR13).
 *
 * The package declares no build script while the lockfile is frozen, so the lib
 * is self-built here when stale.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApprovalStore, createGrantStore } from '@dsh-wfxm/governance'
import { createTaskStore, prepareAssertions } from '@dsh-wfxm/tasks'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

const libFile = join(pkgRoot, 'lib', 'host.js')
const srcFile = join(pkgRoot, 'src', 'host.ts')
const stale = !existsSync(libFile) || statSync(libFile).mtimeMs < statSync(srcFile).mtimeMs
if (stale) {
  const tsc = join(pkgRoot, '..', 'executor', 'node_modules', 'typescript', 'bin', 'tsc')
  execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, 'tsconfig.json')], { stdio: 'inherit' })
}

const { createHostPorts, createRuleForeground, createWfxmHost } = await import('../lib/index.js')

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

const dir = mkdtempSync(join(tmpdir(), 'host-'))
const CLOCK = new Date('2026-11-10T10:00:00.000Z')
const now = () => new Date(CLOCK)
const CHANNEL = 'feishu'
const CHAT = 'oc_main'

let hostSeq = 0
let msgSeq = 0
const uniqueMsg = (prefix = 'm') => {
  msgSeq += 1
  return `${prefix}_${Date.now()}_${msgSeq}`
}

function makeTransport() {
  const sent = []
  return {
    sent,
    async send(delivery) {
      // 卡片结果走 patch（不新建消息）：复用卡片自己的 external_msg_id，
      // 这样 onSent / outbox 记录的是被更新的那条消息 id。
      const patchTarget
        = delivery.payload
          && delivery.payload.kind === 'approval_result'
          && typeof delivery.payload.externalMsgId === 'string'
          ? delivery.payload.externalMsgId
          : null
      const externalMsgId = patchTarget ?? `om_${sent.length + 1}`
      sent.push({ ...delivery, externalMsgId, patched: patchTarget !== null })
      return { externalMsgId }
    },
  }
}

/** One fresh host + DB per test, so nothing leaks between cases. */
function makeHost(overrides = {}) {
  hostSeq += 1
  const dbPath = join(dir, `host-${hostSeq}.sqlite`)
  const transport = overrides.transport ?? makeTransport()
  const calls = []
  const executor = overrides.executor ?? ((task) => {
    calls.push(task.id)
    return { status: 'succeeded', summary: 'executor ok' }
  })
  const host = createWfxmHost({
    dbPath,
    executor,
    transport,
    now,
    ...overrides.options,
  })
  return { host, transport, calls, dbPath }
}

async function pair(host, { externalUserId = 'ou_owner', chatId = CHAT } = {}) {
  const actor = host.stores.gateway.createActor({ kind: 'owner', displayName: 'owner' })
  const { code } = host.stores.gateway.mintPairingCode({ actorId: actor.id, channelId: CHANNEL })
  const result = await host.ingest({
    channelId: CHANNEL,
    msgId: uniqueMsg('bind'),
    externalUserId,
    content: { text: `/bind ${code}` },
    chatId,
  })
  return { actor, result }
}

async function say(host, text, options = {}) {
  const msgId = options.msgId ?? uniqueMsg('m')
  const input = {
    channelId: CHANNEL,
    msgId,
    externalUserId: options.externalUserId ?? 'ou_owner',
    content: options.content ?? { text },
    chatId: options.chatId ?? CHAT,
  }
  if (options.replyToMsgId !== undefined) input.replyToMsgId = options.replyToMsgId
  const result = await host.ingest(input)
  return { result, msgId }
}

// ---- #6 未配对：静默拒绝，不建任务、不出站 -------------------------------------------

await check('an unpaired identity is rejected: no task, no outbound', async () => {
  const { host, transport, calls } = makeHost()
  const { result } = await say(host, 'hello', { externalUserId: 'ou_stranger' })
  const tasks = host.stores.tasks.listTasks()
  const receipts = host.stores.tasks.pendingReceipts()
  host.close()
  return result.result.bypassReason === 'unpaired'
    && result.result.inbox.status === 'rejected'
    && tasks.length === 0
    && receipts.length === 0
    && calls.length === 0
    && transport.sent.length === 0
})

await check('/bind <code> pairs the identity and the next message can start work', async () => {
  const { host } = makeHost()
  const { result: pairResult } = await pair(host)
  const { result } = await say(host, '叫我小王')
  const tasks = host.stores.tasks.listTasks()
  host.close()
  return pairResult.result.bypassReason === 'pairing'
    && pairResult.result.actor !== null
    && result.foreground?.action === 'task-created'
    && tasks.length === 1
    && tasks[0].intent === '叫我小王'
    && tasks[0].status === 'queued'
})

// ---- #2 收消息：① 落库 + 前台建任务（不执行 #11） ------------------------------------

await check('a paired text message becomes one R1 task bound to the thread (no execution)', async () => {
  const { host, calls } = makeHost()
  await pair(host)
  const { result } = await say(host, '把日志清理一下')
  const inbox = host.stores.gateway.getInbox(result.result.inbox.id)
  const thread = host.stores.gateway.getThread(result.result.thread.id)
  const bindings = host.stores.tasks.listTaskThreads({ threadId: thread.id, liveOnly: true })
  const task = host.stores.tasks.getTask(result.foreground.taskId)
  host.close()
  return inbox !== null
    && inbox.status === 'routed'
    && thread !== null
    && result.foreground.action === 'task-created'
    && task.riskLevel === 'R1'
    && task.originMsgId === result.result.inbox.msgId
    && bindings.length === 1
    && bindings[0].relation === 'default_owner'
    && bindings[0].anchorMsgId === result.result.inbox.msgId
    // #11: the front stage created work, it did not run it.
    && task.status === 'queued'
    && calls.length === 0
})

// ---- #5 幂等：同 msgId 重放 ----------------------------------------------------------

await check('replaying the same msgId is a duplicate and creates nothing new', async () => {
  const { host, calls } = makeHost()
  await pair(host)
  const first = await say(host, '重复消息')
  const again = await host.ingest({
    channelId: CHANNEL,
    msgId: first.msgId,
    externalUserId: 'ou_owner',
    content: { text: '重复消息' },
    chatId: CHAT,
  })
  const tasks = host.stores.tasks.listTasks()
  host.close()
  return again.result.duplicate === true
    && again.result.bypassReason === 'duplicate'
    && again.foreground === null
    && tasks.length === 1
    && calls.length === 0
})

// ---- #9 连续前台：同一 thread、同一任务，第二条排队 -----------------------------------

await check('a second message in the same chat merges into the live task instead of parking', async () => {
  const { host } = makeHost()
  await pair(host)
  const first = await say(host, '第一步')
  const second = await say(host, '第二步')
  const taskId = first.result.foreground.taskId
  const inputs = host.stores.tasks.pendingInputs(taskId)
  const task = host.stores.tasks.getTask(taskId)
  const tasks = host.stores.tasks.listTasks()
  const threadIds = new Set([
    first.result.result.thread.id,
    second.result.result.thread.id,
  ])
  const outbound = host.stores.gateway.listOutbox({ status: 'pending' }).map((item) => item.payload.text)
  host.close()
  return threadIds.size === 1
    && second.result.result.target.kind === 'task'
    && second.result.result.target.taskId === taskId
    && second.result.result.relay?.enqueued === true
    && second.result.foreground === null
    && tasks.length === 1
    && inputs.length === 0
    && task.intent.includes('第二步')
    && outbound.some((text) => text.includes('已并入任务'))
})

// ---- 即时 ack：任务建好就回一条，长任务不至于看起来像死机 -----------------------------

await check('creating a task sends one instant ack before any work runs', async () => {
  const { host, transport, calls } = makeHost()
  await pair(host)
  const { result } = await say(host, '慢任务', { content: { text: '慢任务', externalMsgId: 'om_ack_1' } })
  const taskId = result.foreground.taskId
  const task = host.stores.tasks.getTask(taskId)
  const pending = host.stores.gateway.listOutbox({ status: 'pending' })
  const pumped = await host.pump()
  const ack = transport.sent.find((item) => item.topic === 'say')
  host.close()
  return pending.length === 1
    && pending[0].topic === 'say'
    && pending[0].threadId === result.result.thread.id
    && pending[0].replyToMsgId === 'om_ack_1'
    && String(pending[0].payload.text).includes(task.taskRef)
    && calls.length === 0
    && pumped.dispatch?.sent === 1
    && ack !== undefined
})

await check('a failing transport is logged through the host logger (Slice Q)', async () => {
  const logs = []
  const { host } = makeHost({
    transport: {
      async send() {
        throw new Error('socket hang up')
      },
    },
    options: {
      logger: {
        warn: (message) => logs.push(['warn', message]),
        error: (message) => logs.push(['error', message]),
      },
    },
  })
  await pair(host)
  await say(host, '丢不出去')
  const pumped = await host.pump()
  host.close()
  const warnings = logs.filter(([level]) => level === 'warn').map(([, message]) => message)
  return (pumped.dispatch?.retried ?? 0) >= 1
    && warnings.some((message) => /outbox retry 1\/6/.test(message))
    && logs.every(([level]) => level === 'warn')
})

// ---- 全链路：worker 执行 → Verifier 闸 → 回执 → outbox → transport --------------------

await check('worker executes the queued task, the Verifier passes it and a receipt is written', async () => {
  const { host, calls } = makeHost()
  await pair(host)
  const { result } = await say(host, '执行我')
  const report = await host.runWorkerOnce()
  const task = host.stores.tasks.getTask(result.foreground.taskId)
  const receipts = host.stores.tasks.listReceipts(task.id)
  const verified = host.stores.tasks.listEvents(task.id).find((event) => event.type === 'task.verified')
  host.close()
  return report.outcome === 'succeeded'
    && calls.length === 1
    && task.status === 'succeeded'
    && task.leaseOwner === null
    && receipts.length === 1
    && receipts[0].deliveredAt === null
    && verified?.payload.overall === 'no-assertions'
})

await check('pump announces the receipt and the transport ack closes the loop (#3)', async () => {
  const { host, transport } = makeHost()
  await pair(host)
  const { result } = await say(host, '给我回执')
  await host.runWorkerOnce()
  const pumped = await host.pump()
  const taskId = result.foreground.taskId
  const receipts = host.stores.tasks.listReceipts(taskId)
  const outbox = host.stores.gateway.listOutbox().filter((item) => item.taskId === taskId)
  const delivered = transport.sent.find((item) => item.topic === 'task.receipt')
  host.close()
  return pumped.receipts.enqueued === 1
    // 两条：建任务时的即时 ack + 终态回执
    && pumped.dispatch?.sent === 2
    && outbox.length === 1
    && outbox[0].topic === 'task.receipt'
    && outbox[0].status === 'sent'
    && transport.sent.some((item) => item.topic === 'say')
    && delivered !== undefined
    && receipts[0].deliveredAt !== null
    && receipts[0].externalMsgId === delivered.externalMsgId
})

// ---- #10 回执锚点：回复机器人回执回到原任务 -------------------------------------------

await check('a delivered receipt becomes an anchor subscription on the task thread', async () => {
  const { host, transport } = makeHost()
  await pair(host)
  const { result } = await say(host, '锚点测试')
  await host.runWorkerOnce()
  await host.pump()
  const taskId = result.foreground.taskId
  const receipt = transport.sent.find((item) => item.topic === 'task.receipt')
  const threadId = host.stores.tasks.listTaskThreads({ taskId })[0].threadId
  const anchors = host.stores.tasks.listTaskThreads({ threadId })
    .filter((binding) => binding.relation === 'anchor')
  host.close()
  return receipt !== undefined
    && anchors.length === 1
    && anchors[0].taskId === taskId
    && anchors[0].anchorMsgId === receipt.externalMsgId
})

await check('replying in place to the live task message resolves by anchor (#10 live path)', async () => {
  const { host } = makeHost()
  await pair(host)
  const first = await say(host, '原任务')
  const taskId = first.result.foreground.taskId
  const reply = await say(host, '追问一句', { replyToMsgId: first.msgId })
  const inputs = host.stores.tasks.pendingInputs(taskId)
  const task = host.stores.tasks.getTask(taskId)
  host.close()
  return reply.result.result.followUp?.matchedBy === 'anchor'
    && reply.result.result.target.kind === 'task'
    && reply.result.result.target.taskId === taskId
    && reply.result.result.relay?.enqueued === true
    && inputs.length === 0
    && task.intent.includes('追问一句')
})

// ---- AR37：已结束任务的锚点回复必须先过复验 ------------------------------------------

await check('without a grant store a finished task is never woken (fail-closed)', async () => {
  const { host } = makeHost()
  await pair(host)
  const { result } = await say(host, '跑完就结束')
  const taskId = result.foreground.taskId
  await host.runWorkerOnce()
  await host.pump()
  const receiptMsgId = host.stores.tasks.listReceipts(taskId)[0].externalMsgId
  const reply = await say(host, '再补一句', { replyToMsgId: receiptMsgId })
  const task = host.stores.tasks.getTask(taskId)
  host.close()
  return receiptMsgId !== null
    && reply.result.result.wake !== null
    && reply.result.result.wake.granted === false
    && reply.result.result.wake.reason === 'no-grant-store'
    && reply.result.result.wake.woken === false
    && reply.result.result.target.kind === 'orchestrator'
    && task.status === 'succeeded'
})

await check('a granted actor wakes the finished task into round 2 and queues the reply', async () => {
  const grants = createGrantStore(join(dir, 'grants.sqlite'), { now })
  const { host } = makeHost({ options: { grants } })
  const { actor } = await pair(host)
  const { result } = await say(host, '第一轮')
  const taskId = result.foreground.taskId
  await host.runWorkerOnce()
  await host.pump()
  const receiptMsgId = host.stores.tasks.listReceipts(taskId)[0].externalMsgId
  grants.create({ actorId: actor.id, scope: { actions: ['task.wake'] }, kind: 'forever' })
  const reply = await say(host, '开始第二轮', { replyToMsgId: receiptMsgId })
  const task = host.stores.tasks.getTask(taskId)
  const inputs = host.stores.tasks.pendingInputs(taskId)
  host.close()
  grants.close()
  return reply.result.result.wake?.granted === true
    && reply.result.result.wake.woken === true
    && reply.result.result.wake.round === 2
    && task.status === 'queued'
    && task.round === 2
    && reply.result.result.target.taskId === taskId
    && inputs.length === 0
    && task.intent.includes('开始第二轮')
})

// ---- 控制命令 ------------------------------------------------------------------------

await check('stop cancels the live task and writes a receipt', async () => {
  const { host } = makeHost()
  await pair(host)
  const { result } = await say(host, '会被停掉')
  const taskId = result.foreground.taskId
  const stop = await host.ingest({
    channelId: CHANNEL,
    msgId: uniqueMsg('ctl'),
    externalUserId: 'ou_owner',
    content: { control: 'stop' },
    chatId: CHAT,
  })
  const task = host.stores.tasks.getTask(taskId)
  const receipts = host.stores.tasks.listReceipts(taskId)
  host.close()
  return stop.result.target.kind === 'control'
    && stop.result.control?.executed === true
    && stop.result.control.action === 'cancel'
    && task.status === 'cancelled'
    && receipts.length === 1
})

await check('control cancel aborts the running attempt before transitioning', () => {
  const dbPath = join(dir, 'control-cancel.sqlite')
  const tasks = createTaskStore(dbPath)
  const task = tasks.createTask({ intent: '会被停掉', riskLevel: 'R1' })
  tasks.claimTask({ owner: 'worker-A', leaseMs: 60_000, now: new Date() })
  const seen = []
  const ports = createHostPorts({
    tasks,
    now: () => new Date(),
    cancelRunning: (taskId) => {
      seen.push('cancelRunning')
      seen.push(`status:${tasks.getTask(taskId)?.status}`)
      return true
    },
  })
  const result = ports.control.control({ taskId: task.id, action: 'cancel' })
  const row = tasks.getTask(task.id)
  tasks.close()
  return seen[0] === 'cancelRunning'
    && seen[1] === 'status:running'
    && result.status === 'cancelled'
    && row.status === 'cancelled'
})

await check('rollback without a checkpoint port fails loudly instead of pretending', async () => {
  const { host } = makeHost()
  await pair(host)
  const { result } = await say(host, '回滚我')
  const taskId = result.foreground.taskId
  await host.runWorkerOnce()
  const rollback = await host.ingest({
    channelId: CHANNEL,
    msgId: uniqueMsg('ctl'),
    externalUserId: 'ou_owner',
    content: { control: 'rollback' },
    chatId: CHAT,
  })
  const inbox = host.stores.gateway.getInbox(rollback.result.inbox.id)
  host.close()
  return rollback.result.target.kind === 'control'
    && rollback.result.target.command === 'rollback'
    && rollback.result.target.taskId === taskId
    && rollback.result.control === null
    && rollback.error === null
    && rollback.result.error === 'control-unavailable'
    && inbox.status === 'failed'
    && inbox.errorCode === 'control-unavailable'
})

// ---- AR13：前台失败必须大声失败 ------------------------------------------------------
await check('a throwing foreground marks the inbox failed with a route decision', async () => {
  const { host } = makeHost({
    options: { foreground: () => { throw new Error('foreground exploded') } },
  })
  await pair(host)
  const { result } = await say(host, '让前台炸掉')
  const inbox = host.stores.gateway.getInbox(result.result.inbox.id)
  const decisions = host.stores.gateway.listRouteDecisions({ triggerId: result.result.inbox.id })
  const tasks = host.stores.tasks.listTasks()
  host.close()
  return result.error === 'foreground-unavailable'
    && result.foreground === null
    && inbox.status === 'failed'
    && inbox.errorCode === 'foreground-unavailable'
    && decisions.some((decision) => decision.reason.includes('foreground failed'))
    && tasks.length === 0
})

// ---- G2：Verifier 闸收紧后的两条终态 -------------------------------------------------

await check('a failing assertion turns an executor success into a failed task', async () => {
  const { host } = makeHost()
  await pair(host)
  const { result } = await say(host, '我会失败')
  const taskId = result.foreground.taskId
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: join(dir, 'never.txt') }])) {
    host.stores.tasks.addAssertion(taskId, prepared)
  }
  const report = await host.runWorkerOnce()
  const task = host.stores.tasks.getTask(taskId)
  const receipt = host.stores.tasks.listReceipts(taskId)[0]
  host.close()
  return report.outcome === 'failed'
    && task.status === 'failed'
    && receipt.summary.includes('assertion')
})

await check('R3 without a snapshot port is refused before the executor runs', async () => {
  const { host, calls } = makeHost()
  const task = host.stores.tasks.createTask({ intent: '需要快照', riskLevel: 'R3' })
  const report = await host.runWorkerOnce()
  const row = host.stores.tasks.getTask(task.id)
  host.close()
  return report.skipped === 'snapshot-refused'
    && report.outcome === 'failed'
    && row.status === 'failed'
    && calls.length === 0
})

// ---- 非文本消息：前台回复而不是丢消息 ------------------------------------------------

await check('a non-text message gets a reply instead of being dropped', async () => {
  const { host, transport } = makeHost()
  await pair(host)
  const { result } = await say(host, null, { content: { file_key: 'fk_1' } })
  const outbox = host.stores.gateway.listOutbox({ status: 'pending' })
  await host.pump()
  const sent = transport.sent.find((item) => item.topic === 'say')
  host.close()
  return result.foreground?.action === 'reply'
    && outbox.length === 1
    && outbox[0].topic === 'say'
    && sent !== undefined
    && typeof sent.payload.text === 'string'
    && sent.payload.text.length > 0
})

// ---- 切片 G：审批卡片闭环（发卡 → 点按钮 → ③ 决策 → patch 卡片） -----------------------

/** Same database file as the host: `schema_migrations(module)` keeps them apart. */
function makeApprovalHost(suffix) {
  const dbPath = join(dir, `approval-${suffix}.sqlite`)
  const approvals = createApprovalStore(dbPath)
  const made = makeHost({ options: { dbPath, approvals } })
  return { ...made, approvals }
}

async function clickCard(host, { approvalId, decision, nonce, msgId }) {
  return host.ingest({
    channelId: CHANNEL,
    msgId: msgId ?? uniqueMsg('card'),
    externalUserId: 'ou_owner',
    kind: 'card_action',
    content: { approval_id: approvalId, decision, nonce },
    chatId: CHAT,
  })
}

await check('审批 1: requestApproval posts a card, and R3 needs two explicit clicks', async () => {
  const { host, transport, approvals } = makeApprovalHost('closed')
  await pair(host)
  const said = await say(host, '帮我重启 nginx')
  const threadId = said.result.result.thread.id

  const issued = host.requestApproval({
    level: 'R3',
    summary: '重启 nginx',
    impact: { host: 'web-1' },
    threadId,
    chatId: CHAT,
    channelId: CHANNEL,
  })

  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')
  const stored = approvals.get(issued.approvalId)
  const cardRecorded = stored?.externalMsgId === card?.externalMsgId

  // First click: recorded, not decided. No decision patch is sent.
  const first = await clickCard(host, {
    approvalId: issued.approvalId,
    decision: 'approve',
    nonce: card.payload.nonce,
  })
  const staged = approvals.get(issued.approvalId)
  const confirmRows = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.confirm' && item.payload.approvalId === issued.approvalId)
  const settledEarly = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.update' && item.payload.approvalId === issued.approvalId)

  await host.pump()
  const confirmCard = transport.sent.find((item) => item.topic === 'approval.confirm')

  // Second click: the dedicated `confirm` decision settles it.
  const second = await clickCard(host, {
    approvalId: issued.approvalId,
    decision: 'confirm',
    nonce: card.payload.nonce,
  })
  const decided = approvals.get(issued.approvalId)
  const pending = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.update' && item.payload.approvalId === issued.approvalId)

  await host.pump()
  const patched = transport.sent.find((item) => item.topic === 'approval.update')
  host.close()

  return card !== undefined
    && card.payload.kind === 'approval_card'
    && card.payload.approvalId === issued.approvalId
    && typeof card.payload.nonce === 'string' && card.payload.nonce.length > 0
    && stored !== null
    && cardRecorded
    && first.result.inbox.status === 'done'
    && first.result.approval.ok === false
    && first.result.approval.code === 'confirm-required'
    && staged.status === 'pending'
    && staged.confirmStage === 1
    && staged.nonceConsumedAt === null
    && settledEarly.length === 0
    && confirmRows.length === 1
    && confirmRows[0].payload.kind === 'approval_confirm'
    && confirmRows[0].payload.nonce === card.payload.nonce
    && confirmRows[0].payload.externalMsgId === card.externalMsgId
    && confirmCard !== undefined
    && second.result.approval.ok === true
    && decided.status === 'approved'
    && decided.nonceConsumedAt !== null
    && decided.decidedBy !== null
    && pending.length === 1
    && pending[0].payload.kind === 'approval_result'
    && pending[0].payload.externalMsgId === card.externalMsgId
    && patched !== undefined
    && patched.externalMsgId === card.externalMsgId
})

await check('审批 2: a second click is refused and never issues a second patch', async () => {
  const { host, transport, approvals } = makeApprovalHost('repeat')
  await pair(host)
  const said = await say(host, '再重启一次')
  const issued = host.requestApproval({
    level: 'R2',
    summary: '重启 nginx',
    threadId: said.result.result.thread.id,
    chatId: CHAT,
    channelId: CHANNEL,
  })
  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')

  const first = await clickCard(host, {
    approvalId: issued.approvalId,
    decision: 'reject',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('card_first'),
  })
  const second = await clickCard(host, {
    approvalId: issued.approvalId,
    decision: 'reject',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('card_second'),
  })
  const rows = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.update' && item.payload.approvalId === issued.approvalId)
  await host.pump()
  const patches = transport.sent.filter((item) => item.topic === 'approval.update')
  const decisions = host.stores.gateway.listRouteDecisions({ triggerId: second.result.inbox.id })
  host.close()

  return first.result.approval.ok === true
    && second.result.inbox.status === 'failed'
    && second.result.approval.ok === false
    && second.result.approval.code !== 'ok'
    && approvals.get(issued.approvalId).status === 'rejected'
    && rows.length === 1
    && patches.length === 1
    && decisions.length === 1
    && decisions[0].action === 'answer'
})

await check('审批 3: without an approval store, issuing a card refuses loudly (AR13)', async () => {
  const { host, transport } = makeHost()
  await pair(host)
  const said = await say(host, '帮我重启 nginx')
  let thrown = null
  try {
    host.requestApproval({ level: 'R3', summary: 'x', threadId: said.result.result.thread.id })
  } catch (error) {
    thrown = error
  }
  await host.pump()
  const outcomes = transport.sent.filter((item) => item.topic === 'approval.card')
  host.close()
  return thrown instanceof Error
    && thrown.message.includes('approval-unavailable')
    && outcomes.length === 0
})

// ---- 切片 I：审批闸（R2/R3 创建即挂起 → 批准后执行 / 拒绝则暂停） -----------------------

/** Same DB file for host + ③; the rule foreground is pinned to `risk`. */
function makeGatedHost(suffix, { risk = 'R2', withApprovals = true } = {}) {
  const dbPath = join(dir, `gate-${suffix}.sqlite`)
  const approvals = withApprovals ? createApprovalStore(dbPath) : null
  const made = makeHost({
    options: {
      dbPath,
      ...approvals === null ? {} : { approvals },
      foregroundFactory: ({ tasks }) => createRuleForeground({ tasks, defaultRiskLevel: risk }),
    },
  })
  return { ...made, approvals }
}

await check('审批 4: an R2 task is held for approval, carded, and never runs before the click', async () => {
  const { host, transport, calls } = makeGatedHost('hold')
  await pair(host)
  const said = await say(host, '重启 nginx')
  const taskId = said.result.foreground.taskId
  const report = await host.runWorkerOnce()
  const row = host.stores.tasks.getTask(taskId)
  const card = host.stores.gateway.listOutbox().find((item) => item.topic === 'approval.card')
  const ack = host.stores.gateway.listOutbox()
    .find((item) => item.topic === 'say' && String(item.payload.text).includes('确认卡片'))
  const held = host.stores.tasks.listEvents(taskId).find((item) => item.type === 'task.waiting_approval')
  host.close()

  return row.status === 'waiting_approval'
    && report.outcome === 'skipped'
    && calls.length === 0
    && transport.sent.length === 0
    && card !== undefined
    && card.payload.level === 'R2'
    && card.payload.summary === '重启 nginx'
    && card.payload.impact.taskId === taskId
    && ack !== undefined
    && held?.payload.from === 'queued'
})

await check('审批 5: approving re-queues the task and the next worker tick executes it', async () => {
  const { host, transport, calls } = makeGatedHost('approve')
  await pair(host)
  const said = await say(host, '重启 nginx')
  const taskId = said.result.foreground.taskId
  // R2 completion needs executable criteria (17 §8.4).
  const marker = join(dir, 'gate-marker.txt')
  writeFileSync(marker, 'ok')
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    host.stores.tasks.addAssertion(taskId, prepared)
  }

  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')
  const click = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'approve',
    nonce: card.payload.nonce,
  })
  const queued = host.stores.tasks.getTask(taskId)
  const report = await host.runWorkerOnce()
  const done = host.stores.tasks.getTask(taskId)
  const resumes = host.stores.tasks.listEvents(taskId).filter((item) => item.type === 'task.resumed')
  host.close()

  return click.result.approval.ok === true
    && click.result.approval.taskId === taskId
    && click.result.approval.taskStatus === 'queued'
    && queued.status === 'queued'
    && report.taskId === taskId
    && done.status === 'succeeded'
    && calls.length === 1
    && resumes.length === 1
    && resumes[0].payload.approvalId === card.payload.approvalId
})

await check('审批 6: rejecting leaves the task paused and the worker never runs it', async () => {
  const { host, transport, calls } = makeGatedHost('reject')
  await pair(host)
  const said = await say(host, '重启 nginx')
  const taskId = said.result.foreground.taskId
  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')
  const click = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'reject',
    nonce: card.payload.nonce,
  })
  const report = await host.runWorkerOnce()
  const row = host.stores.tasks.getTask(taskId)
  const paused = host.stores.tasks.listEvents(taskId).filter((item) => item.type === 'task.paused').pop()
  host.close()

  return click.result.approval.ok === true
    && click.result.approval.taskId === taskId
    && click.result.approval.taskStatus === 'paused'
    && row.status === 'paused'
    && report.outcome === 'skipped'
    && calls.length === 0
    && paused?.payload.reason === 'approval-rejected'
})

await check('审批 7: a second approve click never resumes the task twice', async () => {
  const { host, transport, calls } = makeGatedHost('double')
  await pair(host)
  const said = await say(host, '重启 nginx')
  const taskId = said.result.foreground.taskId
  // R2 completion needs executable criteria (17 §8.4).
  const marker = join(dir, 'gate-double-marker.txt')
  writeFileSync(marker, 'ok')
  for (const prepared of prepareAssertions([{ kind: 'file_exists', path: marker }])) {
    host.stores.tasks.addAssertion(taskId, prepared)
  }
  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')

  const first = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'approve',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('card_first'),
  })
  const second = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'approve',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('card_second'),
  })
  await host.runWorkerOnce()
  const resumes = host.stores.tasks.listEvents(taskId).filter((item) => item.type === 'task.resumed')
  const row = host.stores.tasks.getTask(taskId)
  host.close()

  return first.result.approval.ok === true
    && second.result.approval.ok === false
    && resumes.length === 1
    && calls.length === 1
    && row.status === 'succeeded'
})

await check('审批 8: R1 keeps the autonomous path (no card, runs on the next tick)', async () => {
  const { host, transport, calls } = makeGatedHost('r1', { risk: 'R1' })
  await pair(host)
  const said = await say(host, '看看时间')
  const taskId = said.result.foreground.taskId
  const report = await host.runWorkerOnce()
  const row = host.stores.tasks.getTask(taskId)
  const card = host.stores.gateway.listOutbox().find((item) => item.topic === 'approval.card')
  host.close()

  return report.taskId === taskId
    && row.status === 'succeeded'
    && calls.length === 1
    && card === undefined
    && !transport.sent.some((item) => item.topic === 'approval.card')
})

await check('审批 9: without an approval store an R2 task is cancelled, never executed (AR13)', async () => {
  const { host, calls } = makeGatedHost('failclosed', { withApprovals: false })
  await pair(host)
  const said = await say(host, '重启 nginx')
  const taskId = said.result.foreground.taskId
  const row = host.stores.tasks.getTask(taskId)
  const receipts = host.stores.tasks.pendingReceipts()
  const report = await host.runWorkerOnce()
  const ack = host.stores.gateway.listOutbox()
    .find((item) => item.topic === 'say' && String(item.payload.text).includes('拒绝执行'))
  host.close()

  return row.status === 'cancelled'
    && receipts.length === 1
    && receipts[0].taskId === taskId
    && receipts[0].summary.includes('未挂载审批模块')
    && report.outcome === 'skipped'
    && calls.length === 0
    && ack !== undefined
})

// ---- 切片 K：确定性风险升级（R1 → R3）+ 模板断言（service_active） ----------------------

await check('审批 10: 「重启 demo 服务」被规则层升到 R3、带 unit_restarted + service_active，批准后执行并复验通过', async () => {
  const dbPath = join(dir, 'gate-escalate.sqlite')
  const approvals = createApprovalStore(dbPath)
  const { host, transport, calls } = makeHost({
    options: {
      dbPath,
      approvals,
      foregroundFactory: ({ tasks }) => createRuleForeground({ tasks, defaultRiskLevel: 'R1' }),
      snapshot: { capture: async () => ({ snapshotId: 'snap-escalate' }) },
      worker: {
        verify: {
          cwd: dir,
          serviceStatus: async (unit) => (unit === 'dsh-wfxm-managed-demo.service' ? 'active' : 'unknown'),
          unitState: async (unit) => (unit === 'dsh-wfxm-managed-demo.service'
            ? { activeState: 'active', activeEnteredAtMs: Date.now() }
            : { activeState: 'unknown', activeEnteredAtMs: null }),
        },
      },
    },
  })
  await pair(host)
  const said = await say(host, '重启 demo 服务')
  const taskId = said.result.foreground.taskId
  const created = host.stores.tasks.getTask(taskId)
  const assertions = host.stores.tasks.listAssertions(taskId)
  const heldReport = await host.runWorkerOnce()
  const callsBeforeApproval = calls.length
  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')
  const staged = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'approve',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('escalate_first'),
  })
  const heldAfterFirst = host.stores.tasks.getTask(taskId)
  const heldCalls = calls.length
  const click = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'confirm',
    nonce: card.payload.nonce,
    msgId: uniqueMsg('escalate_confirm'),
  })
  const report = await host.runWorkerOnce()
  const done = host.stores.tasks.getTask(taskId)
  const snapshot = host.stores.tasks.listEvents(taskId).find((item) => item.type === 'task.snapshot')
  host.close()

  return said.result.foreground.note === 'risk-escalated:svc-start:dsh-wfxm-managed-demo.service'
    && created.riskLevel === 'R3'
    && created.status === 'waiting_approval'
    && assertions.length === 2
    && assertions[0].kind === 'unit_restarted'
    && assertions[1].kind === 'service_active'
    && assertions.every((item) => item.spec.unit === 'dsh-wfxm-managed-demo.service')
    && heldReport.outcome === 'skipped'
    && callsBeforeApproval === 0
    && card !== undefined
    && card.payload.level === 'R3'
    && staged.result.approval.code === 'confirm-required'
    && heldAfterFirst.status === 'waiting_approval'
    && heldCalls === 0
    && click.result.approval.ok === true
    && click.result.approval.taskStatus === 'queued'
    && report.outcome === 'succeeded'
    && done.status === 'succeeded'
    && calls.length === 1
    && snapshot !== undefined
})

// ---- 切片 L：看详情（只读） ----------------------------------------------------------

await check('审批 11: 看详情回显 intent / 风险 / 判据，且不消耗 nonce、不放行任务', async () => {
  const dbPath = join(dir, 'gate-details.sqlite')
  const approvals = createApprovalStore(dbPath)
  const { host, transport } = makeHost({
    options: {
      dbPath,
      approvals,
      foregroundFactory: ({ tasks }) => createRuleForeground({ tasks, defaultRiskLevel: 'R1' }),
      worker: {
        verify: {
          cwd: dir,
          serviceStatus: async (unit) => (unit === 'dsh-wfxm-managed-demo.service' ? 'active' : 'unknown'),
        },
      },
    },
  })
  await pair(host)
  const said = await say(host, '重启 demo 服务')
  const taskId = said.result.foreground.taskId
  const created = host.stores.tasks.getTask(taskId)

  await host.pump()
  const card = transport.sent.find((item) => item.topic === 'approval.card')
  const click = await clickCard(host, {
    approvalId: card.payload.approvalId,
    decision: 'details',
  })
  const rows = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.detail')
  const record = approvals.get(card.payload.approvalId)

  await host.pump()
  const sent = transport.sent.find((item) => item.topic === 'approval.detail')
  const after = host.stores.tasks.getTask(taskId)
  const report = await host.runWorkerOnce()
  host.close()

  return click.result.inbox.status === 'done'
    && click.result.approval === null
    && click.result.details.ok === true
    && click.result.details.detail.approvalId === card.payload.approvalId
    && click.result.details.detail.level === 'R3'
    && click.result.details.detail.summary.length > 0
    && click.result.details.detail.task.taskRef === created.taskRef
    && click.result.details.detail.task.intent === created.intent
    && click.result.details.detail.task.riskLevel === 'R3'
    && click.result.details.detail.task.assertions.length === 2
    && click.result.details.detail.task.assertions[0].kind === 'unit_restarted'
    && click.result.details.detail.task.assertions[1].kind === 'service_active'
    && click.result.details.detail.task.assertions.every(
      (item) => item.spec.unit === 'dsh-wfxm-managed-demo.service',
    )
    && rows.length === 1
    && rows[0].payload.kind === 'approval_detail'
    && sent !== undefined
    && sent.payload.approvalId === card.payload.approvalId
    && record.status === 'pending'
    && record.nonceConsumedAt === null
    && record.confirmStage === 0
    && after.status === 'waiting_approval'
    && report.outcome === 'skipped'
})

// ---- 审批过期清扫：不点按钮也必须释放任务，别把线程占死 ----------------------------

await check('审批 12: a never-clicked approval expires, fails its task and patches the card', async () => {
  // Real clock on both sides: the TTL is the one thing this test must let pass.
  const dbPath = join(dir, 'approval-expired.sqlite')
  const approvals = createApprovalStore(dbPath)
  const { host } = makeHost({ options: { dbPath, approvals, now: () => new Date() } })
  await pair(host)
  const said = await say(host, '帮我重启 nginx')
  const threadId = said.result.result.thread.id
  const taskId = said.result.foreground.taskId
  host.stores.tasks.transition(taskId, { to: 'running', reason: 'manual' })
  host.stores.tasks.transition(taskId, { to: 'waiting_approval', reason: 'risk:R3' })

  const issued = host.requestApproval({
    level: 'R3',
    summary: '重启 nginx',
    impact: { unit: 'nginx.service' },
    taskId,
    threadId,
    chatId: CHAT,
    channelId: CHANNEL,
    ttlMs: 1_000,
  })
  await host.pump()
  const cardId = approvals.get(issued.approvalId)?.externalMsgId ?? null
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const swept = await host.pump()

  const record = approvals.get(issued.approvalId)
  const task = host.stores.tasks.getTask(taskId)
  const updates = host.stores.gateway.listOutbox()
    .filter((item) => item.topic === 'approval.update' && item.payload.approvalId === issued.approvalId)
  host.close()
  return swept.expired === 1
    && record?.status === 'expired'
    && task?.status === 'failed'
    && cardId !== null
    && updates.length === 1
    && updates[0].payload.decision === 'expired'
    && updates[0].payload.externalMsgId === cardId
})

// ---- 长任务可见（Slice R）：pump 按里程碑提醒，且只提醒一次 --------------------------

await check('pump delivers one task.progress notice, then dedupes on the next tick', async () => {
  let clock = new Date('2026-11-10T10:00:00.000Z')
  const { host, transport } = makeHost({ options: { now: () => new Date(clock) } })
  await pair(host)
  const { result } = await say(host, '部署演示服务')
  const taskId = result.foreground.taskId
  const task = host.stores.tasks.getTask(taskId)
  host.stores.tasks.claimTask({ owner: 'w1', leaseMs: 600_000, now: clock })
  clock = new Date(clock.getTime() + 2 * 60_000)
  const first = await host.pump()
  const second = await host.pump()
  const rows = host.stores.gateway.listOutbox().filter((row) => row.topic === 'task.progress')
  const delivered = transport.sent.filter((item) => item.topic === 'task.progress')
  host.close()
  return task !== null
    && first.progress?.enqueued === 1
    && second.progress?.enqueued === 0
    && second.progress?.skippedDuplicate === 1
    && rows.length === 1
    && delivered.length === 1
    && delivered[0].payload.taskRef === task.taskRef
    && /2 分钟/.test(delivered[0].payload.text)
})

await check('a task finished before the milestone never gets a progress notice', async () => {
  let clock = new Date('2026-11-10T10:00:00.000Z')
  const { host, transport } = makeHost({ options: { now: () => new Date(clock) } })
  await pair(host)
  const { result } = await say(host, '立即完成的任务')
  await host.runWorkerOnce()
  clock = new Date(clock.getTime() + 2 * 60_000)
  const pumped = await host.pump()
  const rows = host.stores.gateway.listOutbox().filter((row) => row.topic === 'task.progress')
  const delivered = transport.sent.filter((item) => item.topic === 'task.progress')
  const task = host.stores.tasks.getTask(result.foreground.taskId)
  host.close()
  return task.status === 'succeeded'
    && pumped.progress?.scanned === 0
    && rows.length === 0
    && delivered.length === 0
})

await check('a running task without a live thread is skipped and stays quiet', async () => {
  let clock = new Date('2026-11-10T10:00:00.000Z')
  const { host, transport } = makeHost({ options: { now: () => new Date(clock) } })
  const task = host.stores.tasks.createTask({ intent: '没有线程的任务', riskLevel: 'R1' })
  host.stores.tasks.claimTask({ owner: 'w2', leaseMs: 600_000, now: clock })
  clock = new Date(clock.getTime() + 2 * 60_000)
  const pumped = await host.pump()
  const rows = host.stores.gateway.listOutbox().filter((row) => row.topic === 'task.progress')
  const status = host.stores.tasks.getTask(task.id)?.status
  host.close()
  return status === 'running'
    && pumped.progress?.skippedNoThread === 1
    && pumped.progress?.enqueued === 0
    && rows.length === 0
    && transport.sent.filter((item) => item.topic === 'task.progress').length === 0
})

await check('watchdog pause aborts the live attempt before moving the row to paused', async () => {
  // Task events are stamped with wall time, so anchor the pinned clock ahead of
  // it and jump 16 minutes; silence is measured from the real `task.started`.
  let clock = new Date(Date.now() + 60_000)
  let started = null
  let statusAtAbort = null
  let hostRef = null
  const { host } = makeHost({
    options: {
      now: () => new Date(clock),
      progress: { stallMs: 15 * 60_000, pauseOnStall: true },
      executor: (task, hooks) => new Promise((resolve) => {
        started = task.id
        hooks.signal?.addEventListener('abort', () => {
          // The row must still be `running` here: abort is the first of the two
          // writes, so a paused row would mean the transition ran first.
          statusAtAbort = hostRef.stores.tasks.getTask(task.id)?.status ?? null
          resolve({ status: 'failed', failure: 'conflict', summary: 'aborted by watchdog' })
        }, { once: true })
      }),
    },
  })
  hostRef = host
  await pair(host)
  const { result } = await say(host, '一直不发事件的卡住任务')
  const taskId = result.foreground.taskId
  const running = host.runWorkerOnce()
  for (let i = 0; i < 200 && started === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  clock = new Date(clock.getTime() + 16 * 60_000)
  const pumped = await host.pump()
  const afterPump = host.stores.tasks.getTask(taskId)
  const report = await running
  host.close()
  return started === taskId
    && pumped.progress?.stalled.length === 1
    && statusAtAbort === 'running'
    && afterPump.status === 'paused'
    && report.outcome === 'skipped'
    && report.skipped === 'paused'
})

await check('a failed watchdog pause transition is logged and swallowed', async () => {
  let clock = new Date(Date.now() + 60_000)
  const warnings = []
  const { host } = makeHost({
    options: {
      now: () => new Date(clock),
      progress: { stallMs: 15 * 60_000, pauseOnStall: true },
      logger: { warn: (message) => warnings.push(message) },
    },
  })
  await pair(host)
  const { result } = await say(host, '检测后已经结束的任务')
  const taskId = result.foreground.taskId
  host.stores.tasks.claimTask({ owner: host.worker.owner, leaseMs: 600_000, now: clock })
  clock = new Date(clock.getTime() + 16 * 60_000)
  const original = host.stores.tasks.transition
  host.stores.tasks.transition = () => {
    throw new Error('task already finished')
  }
  let threw = false
  let pumped = null
  try {
    pumped = await host.pump()
  } catch {
    threw = true
  } finally {
    host.stores.tasks.transition = original
  }
  const status = host.stores.tasks.getTask(taskId)?.status
  const ok = !threw
    && pumped?.progress?.stalled.length === 1
    && status === 'running'
    && warnings.some((message) => /watchdog pause skipped/.test(message))
  host.close()
  return ok
})

// ---- Slice AO：补充指令打断重跑，而不是静默入库 ---------------------------------------

await check('a supplement steers the running task and acks the restart', async () => {
  const { host } = makeHost({
    options: {
      foregroundFactory: ({ tasks }) => (input) => {
        const threadId = input.result.thread?.id ?? null
        if (threadId === null) return { action: 'none', reason: 'no-thread' }
        const live = tasks.listTaskThreads({ threadId, liveOnly: true })
          .map((binding) => tasks.getTask(binding.taskId))
          .find((task) => task !== null && task.status === 'running')
        if (live === undefined || live === null) return { action: 'none', reason: 'no-live' }
        const queued = tasks.enqueueInput({ taskId: live.id, inboxId: input.result.inbox.id })
        return { action: 'input-queued', taskId: live.id, inputId: queued.id }
      },
    },
  })
  await pair(host)
  const first = await say(host, '初始化线程')
  const threadId = first.result.result.thread.id
  const task = host.stores.tasks.createTask({ intent: '统计大文件', riskLevel: 'R1' })
  host.stores.tasks.bindThread({ taskId: task.id, threadId, relation: 'default_owner' })
  host.stores.tasks.claimTask({ owner: 'w1', leaseMs: 60_000, now: now() })

  const second = await say(host, '只统计 /var')
  const steered = host.stores.tasks.getTask(task.id)
  const outbound = host.stores.gateway.listOutbox().map((item) => item.payload.text)
  host.close()
  return second.result.result.target.kind === 'task'
    && steered.status === 'queued'
    && steered.intent.includes('只统计 /var')
    && outbound.some((text) => text.includes('已按补充指令重新开始'))
})

await check('an identical repeat does not steer the live task', async () => {
  const { host } = makeHost()
  await pair(host)
  const first = await say(host, '第一步')
  const taskId = first.result.foreground.taskId
  const before = host.stores.tasks.getTask(taskId)
  const second = await say(host, '第一步')
  const after = host.stores.tasks.getTask(taskId)
  const outbound = host.stores.gateway.listOutbox().map((item) => item.payload.text)
  host.close()
  return second.result.result.duplicate === true
    && after.intent === before.intent
    && !outbound.some((text) => text.includes('已按补充指令重新开始'))
})

// ---- Slice AR：任务问人 → pump 追问一次 → 回复后继续 ----------------------------------

await check('a waiting_input task is asked once, and the reply requeues it', async () => {
  const { host } = makeHost()
  await pair(host)
  const first = await say(host, '把报告写到指定目录')
  const threadId = first.result.result.thread.id
  const taskId = first.result.foreground.taskId

  host.stores.tasks.claimTask({ owner: 'w1', leaseMs: 60_000, now: now() })
  host.stores.tasks.parkForInput({ taskId, question: '目标目录是哪个？' })

  await host.pump()
  const asked = host.stores.gateway.listOutbox()
    .filter((item) => typeof item.payload.text === 'string' && item.payload.text.includes('需要补充信息'))
  const secondPump = await host.pump()

  const parked = host.stores.tasks.getTask(taskId)
  const reply = await say(host, '/tmp/report')
  const resumed = host.stores.tasks.getTask(taskId)
  const outbound = host.stores.gateway.listOutbox().map((item) => item.payload.text)
  host.close()
  return asked.length === 1
    && asked[0].payload.text.includes('目标目录是哪个？')
    && secondPump.inputRequests === 0
    && parked.status === 'waiting_input'
    && reply.result.result.target.kind === 'task'
    && resumed.status === 'queued'
    && resumed.intent.includes('/tmp/report')
    && outbound.some((text) => typeof text === 'string' && text.includes('已按补充指令重新开始'))
})

// ---- AR32 / AR33：组合根里不许出现表名、SQL 或渠道协议名 ------------------------------

await check('plugins/host/src contains no SQL, table names or channel protocol nouns', () => {
  const sources = readdirSync(join(pkgRoot, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(pkgRoot, 'src', file), 'utf8') }))
  const forbidden = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE)\b|feishu|lark|open_id|chat_id|msg_id|app_id/i
  const hits = sources.filter((source) => forbidden.test(source.text) && !source.text.includes('Feishu-shaped'))
    .map((source) => source.file)
  return sources.length >= 3 && hits.length === 0
})

// ---- teardown -----------------------------------------------------------------------

rmSync(dir, { recursive: true, force: true })

console.log(`\nhost: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
