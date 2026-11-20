/**
 * Real end-to-end smoke (切片 C, docs/14 §九 #2/#3/#10).
 *
 * Composition happens here — the one place allowed to know both the channel and
 * the executor — and the host stays transport-agnostic:
 *
 *   Feishu long connection → ① ingest → foreground → ⑤ worker → dsh executor
 *   → Verifier → receipt → ① outbox → Feishu transport → back to the chat
 *
 * Requires real credentials (`loadFeishuCredentials()` reads
 * ~/.dsh/integrations/dsh-feishu/config.json) and a working `dsh` binary. If
 * nothing is paired yet it prints a `/bind <code>` code; send that to the bot.
 *
 *   node scripts/e2e-smoke.mjs
 *   node scripts/e2e-smoke.mjs --approval   # 首条消息后发一张审批卡，供 owner 点按钮
 *
 * Stop with Ctrl+C.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createTaskStore } from '@dsh-wfxm/tasks'
import { createDshExecutor } from '@dsh-wfxm/executor'
import {
  createFeishuChannel,
  createFeishuTransport,
  createLarkClient,
  loadFeishuCredentials,
} from '@dsh-wfxm/feishu'
import { createApprovalStore } from '@dsh-wfxm/governance'
import { createRuleForeground, createWfxmHost } from '@dsh-wfxm/host'
import { createDecisionRunner, createOrchestratorForeground } from '@dsh-wfxm/orchestrator'
import { createResourceProbe, createSystemdAdapter, probeListeningPorts, probeLogErrors, spawnRunner } from '@dsh-wfxm/svcops'

// better-sqlite3 / dsh both break when Trae injects an old libstdc++ path.
delete process.env.LD_LIBRARY_PATH

const dbPath = process.env.DSH_WFXM_DB ?? join(process.cwd(), '.wfxm', 'ops.sqlite')
process.env.DSH_WFXM_DB = dbPath
const workdir = process.env.DSH_WFXM_WORKDIR ?? join(process.cwd(), '.wfxm', 'workspace')
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(workdir, { recursive: true })

// `--approval` additionally mounts ③ and, on the first inbound message, posts
// one approval card into that chat so the owner can click 批准 / 拒绝 and watch
// the card get patched in place (docs/14 §九 #4). The click itself stays manual.
const wantApproval = process.argv.includes('--approval')
const approvals = wantApproval ? createApprovalStore(dbPath) : null
let approvalSent = false

/** Set when the model-backed front desk is enabled; closed on shutdown. */
let decideRunner = null

function log(step, detail) {
  const text = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`[${new Date().toISOString()}] ${step}${text}`)
}

const credentials = loadFeishuCredentials()
log('credentials', { appId: credentials.appId, domain: credentials.domain })

const client = await createLarkClient({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  ...credentials.domain === null ? {} : { domain: credentials.domain },
})

// Late-bound: the transport is built before the host, and only needs the ① view
// of "which chat does this thread belong to" when a row carries a threadId.
let host = null
const transport = createFeishuTransport({
  client,
  resolveChatId: (threadId) => host?.stores.gateway.getThread(threadId)?.chatId ?? null,
  logger: {
    info: (message, meta) => log('transport', meta === undefined ? message : { message, ...meta }),
    warn: (message, meta) => log('transport:warn', meta === undefined ? message : { message, ...meta }),
    error: (message, meta) => log('transport:error', meta === undefined ? message : { message, ...meta }),
  },
})

const executor = createDshExecutor({
  env: { ...process.env },
  defaultWorkdir: workdir,
  timeoutMs: 600_000,
})

host = createWfxmHost({
  dbPath,
  executor,
  transport,
  ...approvals === null ? {} : { approvals },
  worker: { verify: { cwd: workdir } },
  // `DSH_WFXM_FOREGROUND=orchestrator` swaps the rule front desk for the real
  // one (one tool-less dsh turn per message). Default keeps the deterministic
  // path so this smoke stays comparable.
  ...process.env.DSH_WFXM_FOREGROUND !== 'orchestrator'
    ? {}
    : {
        foregroundFactory: ({ tasks }) => {
          const runner = createDecisionRunner({
            kind: process.env.DSH_WFXM_DECIDE_RUNNER ?? 'sdk',
            timeoutMs: Number(process.env.DSH_WFXM_DECIDE_TIMEOUT_MS ?? 60_000),
            logger: { warn: (message) => log('front:warn', message) },
          })
          decideRunner = runner
          void runner
            .warm()
            .then(() => log('front:warm', process.env.DSH_WFXM_DECIDE_RUNNER ?? 'sdk'))
            .catch((error) => log('front:warn', `warm failed: ${error instanceof Error ? error.message : String(error)}`))
          const systemd = createSystemdAdapter({ runner: spawnRunner })
          return createOrchestratorForeground({
            tasks,
            decide: runner,
            probe: createResourceProbe({ runner: spawnRunner }),
            checks: {
              unitStatus: async (unit) => {
                try {
                  return (await systemd.status(unit)).activeState
                } catch {
                  return null
                }
              },
              listeningPorts: () => probeListeningPorts(spawnRunner),
              logErrors: (minutes) => probeLogErrors(spawnRunner, minutes),
            },
            fallback: createRuleForeground({ tasks }),
            logger: { warn: (message) => log('front:warn', message) },
          })
        },
      },
  logger: {
    info: (message) => log('host', message),
    warn: (message) => log('host:warn', message),
  },
})

async function onMessage(message) {
  log('in', {
    msgId: message.msgId,
    chatId: message.chatId,
    replyToMsgId: message.replyToMsgId,
    content: message.content,
  })
  const turn = await host.ingest({
    channelId: message.channelId,
    msgId: message.msgId,
    externalUserId: message.externalUserId,
    kind: 'message',
    content: message.content,
    chatId: message.chatId,
    topicId: message.topicId,
    rootMsgId: message.rootMsgId,
    replyToMsgId: message.replyToMsgId,
  })
  log('route', {
    target: turn.result.target,
    bypass: turn.result.bypassReason,
    followUp: turn.result.followUp === null
      ? null
      : {
        matchedBy: turn.result.followUp.matchedBy,
        taskId: turn.result.followUp.taskId,
        status: turn.result.followUp.status,
      },
    relay: turn.result.relay ?? null,
    control: turn.result.control ?? null,
    wake: turn.result.wake ?? null,
    foreground: turn.foreground,
    error: turn.error ?? turn.result.error,
  })

  if (turn.error === 'foreground-unavailable') return

  // A created task is executed here because this smoke has no background worker
  // loop running under a supervisor; the host itself never runs work inline.
  if (turn.foreground?.action === 'task-created') {
    const report = await host.runWorkerOnce()
    log('worker', report)
  }
  const pumped = await host.pump()
  log('pump', pumped)
  const last = transportedLast()
  if (last !== null) {
    log('delivered', { externalMsgId: last.externalMsgId, hint: '回复这条回执即可验证 #10' })
  }

  if (wantApproval && !approvalSent) {
    approvalSent = true
    try {
      const thread = host.stores.gateway.resolveThread({
        channelId: message.channelId,
        chatId: message.chatId,
      })
      const issued = host.requestApproval({
        level: 'R2',
        summary: '冒烟：请点「批准」验证卡片回调与 patch',
        impact: { smoke: true, chat: message.chatId },
        threadId: thread.id,
        chatId: message.chatId,
        channelId: message.channelId,
      })
      log('approval', {
        approvalId: issued.approvalId,
        hint: '点卡片上的「批准」，应看到卡片就地变为「已批准」',
      })
      await host.pump()
    } catch (error) {
      log('approval:error', error instanceof Error ? error.message : String(error))
    }
  }
}

/** `card.action.trigger` sink: normalize → ① ingest(kind=card_action) → pump the patch. */
async function onCardAction(action) {
  log('card', { msgId: action.msgId, chatId: action.chatId, action: action.action })
  const turn = await host.ingest({
    channelId: action.channelId,
    msgId: action.msgId,
    externalUserId: action.externalUserId,
    kind: 'card_action',
    content: action.action,
    ...action.chatId === null ? {} : { chatId: action.chatId },
    ...action.replyToMsgId === null ? {} : { replyToMsgId: action.replyToMsgId },
  })
  log('card:result', {
    inbox: turn.result.inbox.status,
    approval: turn.result.approval ?? null,
    error: turn.error ?? turn.result.error,
  })
  await host.pump()

  // Feishu requires the callback to answer within a few seconds; the toast is
  // what the clicker sees. Second clicks land on `not-pending` (idempotent).
  const approval = turn.result.approval ?? null
  if (approval === null) return { ok: true, toast: '已处理' }
  if (approval.ok) {
    return { ok: true, toast: approval.status === 'approved' ? '已批准' : '已拒绝' }
  }
  return {
    ok: false,
    toast: approval.code === 'not-pending' ? '该审批已处理' : `处理失败：${approval.code}`,
  }
}

// Track what actually left the process so the owner knows what to reply to.
const delivered = []
const rawSend = transport.send.bind(transport)
transport.send = async (item) => {
  const result = await rawSend(item)
  delivered.push({ externalMsgId: result.externalMsgId, topic: item.topic, taskId: item.taskId })
  return result
}
function transportedLast() {
  return delivered.length === 0 ? null : delivered[delivered.length - 1]
}

const channel = createFeishuChannel({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
  ...credentials.domain === null ? {} : { domain: credentials.domain },
  onMessage,
  ...wantApproval ? { onCardAction } : {},
  logger: {
    info: (message, meta) => log('channel', meta === undefined ? message : { message, ...meta }),
    warn: (message, meta) => log('channel:warn', meta === undefined ? message : { message, ...meta }),
    error: (message, meta) => log('channel:error', meta === undefined ? message : { message, ...meta }),
  },
})

// Pairing: only mint a code when nothing is bound yet (a fresh DB).
if (host.stores.gateway.listBindings().length === 0) {
  const actor = host.stores.gateway.createActor({ kind: 'owner', displayName: 'smoke-owner' })
  const { code, expiresAt } = host.stores.gateway.mintPairingCode({
    actorId: actor.id,
    channelId: credentials.appId,
  })
  log('pairing', { hint: `在飞书给机器人发：/bind ${code}`, expiresAt })
}

await channel.start()
log('ready', { dbPath, workdir, hint: '现在在飞书给机器人发一条文本消息' })

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log('shutdown', signal)
  await channel.stop()
  try {
    await decideRunner?.close()
  } catch (error) {
    log('front:warn', `close failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  host.close()
  try {
    approvals?.close()
  } catch {
    // already closed with the host's shared database handle
  }
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await new Promise(() => {})
