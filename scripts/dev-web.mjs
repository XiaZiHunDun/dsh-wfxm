/**
 * Dev-only web harness: drive the host from a browser instead of typing in Feishu.
 *
 * It is a *local* channel adapter (`webdev`) with a loopback transport, so the
 * whole chain still runs for real — ① ingest → foreground → ⑤ worker → executor
 * → Verifier → receipt → ① outbox → transport — only the transport is a page
 * instead of the Feishu long connection.
 *
 *   node scripts/dev-web.mjs                 # stub executor (fast, no model)
 *   DSH_WFXM_DEV_EXECUTOR=dsh node ...       # real dsh headless executor
 *   DSH_WFXM_FOREGROUND=orchestrator ...     # model-backed front desk (real dsh turn)
 *   DSH_WFXM_DECIDE_RUNNER=sdk|headless ...  # resident runtime (default) or one cold turn per message
 *   DSH_WFXM_DEV_RESET=1 ...                 # start from an empty DB
 *
 * Open http://127.0.0.1:8787 (port via DSH_WFXM_DEV_PORT).
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDshExecutor } from '@dsh-wfxm/executor'
import { createGrantStore } from '@dsh-wfxm/governance'
import { createRuleForeground, createWfxmHost } from '@dsh-wfxm/host'
import { createDecisionRunner, createOrchestratorForeground } from '@dsh-wfxm/orchestrator'
import { createResourceProbe, createSystemdAdapter, probeListeningPorts, probeLogErrors, spawnRunner } from '@dsh-wfxm/svcops'

delete process.env.LD_LIBRARY_PATH

const CHANNEL = 'webdev'
const EXTERNAL_USER = 'web-owner'
const CHAT = 'web-chat'

const port = Number(process.env.DSH_WFXM_DEV_PORT ?? 8787)
const root = process.env.DSH_WFXM_DEV_ROOT ?? join(process.cwd(), '.wfxm', 'dev')
const dbPath = join(root, 'ops.sqlite')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true })
if (process.env.DSH_WFXM_DEV_RESET === '1') {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
}

const mode = process.env.DSH_WFXM_DEV_EXECUTOR === 'dsh' ? 'dsh' : 'stub'
const runnerKind = process.env.DSH_WFXM_DECIDE_RUNNER ?? 'sdk'
/** Set when the model-backed front desk is enabled; closed on shutdown. */
let decideRunner = null

const delivered = []
const transport = {
  async send(item) {
    const externalMsgId = `web_${delivered.length + 1}`
    delivered.push({ ...item, externalMsgId })
    return { externalMsgId }
  },
}

const stubExecutor = (task) => {
  const inputs = host.stores.tasks.pendingInputs(task.id)
  const file = join(workspace, `task-${task.id}.txt`)
  writeFileSync(file, `intent: ${task.intent}\nrisk: ${task.riskLevel}\ninputs: ${inputs.length}\n`)
  const extra = inputs.length === 0 ? '' : `（含 ${inputs.length} 条追加消息）`
  return { status: 'succeeded', summary: `已完成：${task.intent}${extra}` }
}

const executor = mode === 'dsh'
  ? createDshExecutor({ defaultWorkdir: workspace, timeoutMs: 180_000 })
  : stubExecutor

const grants = createGrantStore(join(root, 'grants.sqlite'))

const host = createWfxmHost({
  dbPath,
  executor,
  transport,
  grants,
  worker: { verify: { cwd: workspace } },
  // Default stays the deterministic rule foreground; `DSH_WFXM_FOREGROUND=orchestrator`
  // swaps in the model-backed front desk (one tool-less dsh turn per message).
  ...process.env.DSH_WFXM_FOREGROUND !== 'orchestrator'
    ? {}
    : {
        foregroundFactory: ({ tasks }) => {
          // One resident decision runtime, warmed before the first message so
          // the profile mount is not charged to the user's first request.
          const runner = createDecisionRunner({
            kind: runnerKind,
            timeoutMs: Number(process.env.DSH_WFXM_DECIDE_TIMEOUT_MS ?? 60_000),
            logger: { warn: (message) => console.warn(`[front] ${message}`) },
          })
          decideRunner = runner
          void runner
            .warm()
            .then(() => console.log(`[front] decision runtime warm (${runnerKind})`))
            .catch((error) => console.warn(`[front] warm failed: ${error instanceof Error ? error.message : String(error)}`))
          const systemd = createSystemdAdapter({ runner: spawnRunner })
          return createOrchestratorForeground({
            tasks,
            decide: runner,
            // Read-only questions (磁盘/内存/负载/任务进度/unit/端口/日志) answer in milliseconds.
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
            logger: { warn: (message) => console.warn(`[front] ${message}`) },
          })
        },
      },
  logger: { warn: (message) => console.warn(`[host] ${message}`) },
})

function ensureBound() {
  const bindings = host.stores.gateway.listBindings()
  if (bindings.length > 0) return bindings[0].actorId
  const actor = host.stores.gateway.createActor({ kind: 'owner', displayName: 'web-owner' })
  host.stores.gateway.bindChannel({
    actorId: actor.id,
    channelId: CHANNEL,
    externalUserId: EXTERNAL_USER,
  })
  return actor.id
}

// Dev convenience only: allow "reply to the receipt" to wake the finished task
// (AR37). In production the grant is issued from the Web admin page (③).
const ownerActorId = ensureBound()
if (grants.list({ actorId: ownerActorId }).length === 0) {
  grants.create({ actorId: ownerActorId, scope: { actions: ['task.wake'] }, kind: 'forever' })
}

let msgSeq = 0

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

function render(item) {
  if (item.topic === 'say') return String(item.payload?.text ?? '')
  if (item.topic === 'task.receipt') return `任务回执：${String(item.payload?.summary ?? '')}`
  return `${item.topic}: ${JSON.stringify(item.payload)}`
}

async function send(text, replyToMsgId) {
  const before = delivered.length
  msgSeq += 1
  const message = {
    channelId: CHANNEL,
    msgId: replyToMsgId === null ? `web-msg-${msgSeq}` : `web-reply-${msgSeq}`,
    externalUserId: EXTERNAL_USER,
    kind: 'message',
    content: { text },
    chatId: CHAT,
  }
  if (replyToMsgId !== null) message.replyToMsgId = replyToMsgId
  const turn = await host.ingest(message)

  const workers = []
  const workStarted = turn.foreground?.action === 'task-created' || turn.result.wake?.woken === true
  if (workStarted) {
    for (let i = 0; i < 5; i += 1) {
      const report = await host.runWorkerOnce()
      workers.push(report)
      if (report.skipped === 'idle') break
    }
  }
  for (let i = 0; i < 10; i += 1) {
    const pumped = await host.pump()
    if ((pumped.dispatch?.sent ?? 0) === 0) break
  }

  return {
    route: turn.result.target,
    bypassReason: turn.result.bypassReason,
    followUp: turn.result.followUp,
    relay: turn.result.relay ?? null,
    control: turn.result.control ?? null,
    wake: turn.result.wake ?? null,
    foreground: turn.foreground,
    error: turn.error ?? turn.result.error,
    workers,
    replies: delivered.slice(before).map((item) => ({
      externalMsgId: item.externalMsgId,
      topic: item.topic,
      text: render(item),
      taskId: item.taskId ?? null,
      replyToMsgId: item.replyToMsgId ?? null,
    })),
    tasks: host.stores.tasks.listTasks().map((task) => ({
      id: task.id,
      intent: task.intent,
      status: task.status,
      riskLevel: task.riskLevel,
      round: task.round,
      projectId: task.projectId,
    })),
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-wfxm · dev web</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
         background: #0f1115; color: #e6e8ee; }
  header { padding: 12px 16px; border-bottom: 1px solid #262b36; display: flex; gap: 12px;
           align-items: center; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #1d2430; color: #9fb3c8; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  #log { display: flex; flex-direction: column; gap: 10px; min-height: 320px; }
  .row { display: flex; gap: 8px; }
  .row.user { justify-content: flex-end; }
  .bubble { max-width: 78%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap;
            word-break: break-word; }
  .user .bubble { background: #2b6cb0; color: #fff; border-bottom-right-radius: 4px; }
  .bot .bubble { background: #1a2029; border: 1px solid #262b36; border-bottom-left-radius: 4px; }
  .meta { font-size: 11px; color: #7c8aa0; margin-top: 4px; }
  .reply { background: none; border: 1px solid #3a465a; color: #9fb3c8; border-radius: 8px;
           font-size: 11px; padding: 1px 8px; cursor: pointer; margin-top: 6px; }
  .reply:hover { border-color: #5a6b86; color: #dfe7f2; }
  footer { position: sticky; bottom: 0; background: #0f1115; border-top: 1px solid #262b36;
           padding: 12px 16px; }
  .composer { max-width: 860px; margin: 0 auto; display: flex; gap: 8px; }
  #text { flex: 1; padding: 10px 12px; border-radius: 10px; border: 1px solid #2c3442;
          background: #141922; color: inherit; font: inherit; }
  #send { padding: 10px 18px; border-radius: 10px; border: 0; background: #2b6cb0; color: #fff;
          font-weight: 600; cursor: pointer; }
  #send[disabled] { opacity: .5; cursor: default; }
  #ctx { max-width: 860px; margin: 8px auto 0; font-size: 12px; color: #7c8aa0; }
  #ctx button { background: none; border: 0; color: #9fb3c8; cursor: pointer; text-decoration: underline; }
  #status { max-width: 860px; margin: 10px auto 0; font: 11px/1.5 ui-monospace, monospace;
            color: #6d7c93; white-space: pre-wrap; max-height: 150px; overflow: auto; }
  .err .bubble { border-color: #7a2f2f; background: #2a1a1a; }
</style>
</head>
<body>
<header>
  <h1>dsh-wfxm · 本地 Web 调试通道</h1>
  <span class="tag">executor: ${mode}</span>
  <span class="tag">① ingest → 前台 → ⑤ worker → 回执 → outbox</span>
</header>
<main>
  <div id="log"></div>
</main>
<footer>
  <form class="composer" id="form">
    <input id="text" placeholder="发一条消息，例如：帮我看看磁盘" autocomplete="off">
    <button id="send" type="submit">发送</button>
  </form>
  <div id="ctx"></div>
  <div id="status"></div>
</footer>
<script>
const log = document.getElementById('log')
const form = document.getElementById('form')
const input = document.getElementById('text')
const sendBtn = document.getElementById('send')
const ctx = document.getElementById('ctx')
const status = document.getElementById('status')
let replyTo = null

function bubble(kind, text, meta, replyButton) {
  const row = document.createElement('div')
  row.className = 'row ' + kind
  const box = document.createElement('div')
  box.className = 'bubble'
  box.textContent = text
  row.appendChild(box)
  if (meta) {
    const m = document.createElement('div')
    m.className = 'meta'
    m.textContent = meta
    box.appendChild(m)
  }
  if (replyButton) box.appendChild(replyButton)
  log.appendChild(row)
  log.scrollTop = log.scrollHeight
}

function setCtx(msgId) {
  replyTo = msgId
  ctx.textContent = ''
  if (!msgId) return
  const span = document.createElement('span')
  span.textContent = '正在回复 ' + msgId + ' '
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  cancel.onclick = () => setCtx(null)
  ctx.append(span, cancel)
}

form.onsubmit = async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text) return
  sendBtn.disabled = true
  bubble('user', text, replyTo ? '回复 ' + replyTo : null)
  input.value = ''
  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, replyToMsgId: replyTo }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || response.statusText)
    for (const reply of data.replies) {
      const button = document.createElement('button')
      button.className = 'reply'
      button.textContent = '回复这条'
      button.onclick = () => setCtx(reply.externalMsgId)
      const meta = [reply.externalMsgId, reply.taskId ? 'task ' + reply.taskId : null]
        .filter(Boolean).join(' · ')
      bubble('bot', reply.text, meta, button)
    }
    if (data.replies.length === 0) {
      bubble('bot err', '本轮没有出站消息', null, null)
    }
    const line = {
      target: data.route,
      bypass: data.bypassReason,
      followUp: data.followUp && {
        matchedBy: data.followUp.matchedBy,
        taskId: data.followUp.taskId,
        status: data.followUp.status,
      },
      relay: data.relay,
      control: data.control,
      wake: data.wake,
      foreground: data.foreground,
      workers: data.workers.map((w) => ({ outcome: w.outcome, skipped: w.skipped, taskId: w.taskId })),
      error: data.error,
    }
    status.textContent = JSON.stringify(line, null, 2)
    setCtx(null)
  } catch (error) {
    bubble('bot err', String(error.message || error), null, null)
  } finally {
    sendBtn.disabled = false
    input.focus()
  }
}

input.focus()
</script>
</body>
</html>`

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(PAGE)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/send') {
      const body = await readBody(request)
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim() === '') {
        json(response, 400, { error: 'text is required' })
        return
      }
      const replyToMsgId = typeof body.replyToMsgId === 'string' && body.replyToMsgId !== ''
        ? body.replyToMsgId
        : null
      json(response, 200, await send(text, replyToMsgId))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      json(response, 200, {
        mode,
        tasks: host.stores.tasks.listTasks(),
        receipts: host.stores.tasks.pendingReceipts(),
        outbox: host.stores.gateway.listOutbox(),
        delivered,
      })
      return
    }
    json(response, 404, { error: 'not-found' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`dev-web ready: http://127.0.0.1:${port}  (executor=${mode}, db=${dbPath})`)
})

const shutdown = async () => {
  server.close()
  try {
    await decideRunner?.close()
  } catch (error) {
    console.warn(`[front] close failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  host.close()
  grants.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
