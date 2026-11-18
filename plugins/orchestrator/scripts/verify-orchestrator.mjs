/**
 * Hermetic acceptance for @dsh-wfxm/orchestrator (切片 D — 真实前台决策引擎).
 *
 * No network, no model: the decision seam is a stub function in-process tests
 * and a fake `dsh` binary (same argv/NDJSON shape) in runner tests. A real
 * SQLite host proves the wiring: ① ingest → orchestrator foreground →
 * reply / task / queue → ⑤, plus degradation to the rule foreground.
 *
 * The package declares no build script while the lockfile is frozen, so libs
 * are self-built here when stale.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
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

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

const tsc = join(repoRoot, 'plugins', 'executor', 'node_modules', 'typescript', 'bin', 'tsc')
function buildIfStale(pkg) {
  const lib = join(pkgRoot, '..', pkg, 'lib', 'index.js')
  const srcDir = join(pkgRoot, '..', pkg, 'src')
  const libTime = existsSync(lib) ? statSync(lib).mtimeMs : 0
  const newestSrc = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .reduce((max, name) => Math.max(max, statSync(join(srcDir, name)).mtimeMs), 0)
  if (libTime < newestSrc) {
    execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, '..', pkg, 'tsconfig.json')], { stdio: 'inherit' })
  }
}
buildIfStale('orchestrator')
buildIfStale('host')

const {
  DEFAULT_DECISION_RUNNER,
  NON_TEXT_REPLY,
  buildDecisionPrompt,
  createDecisionRunner,
  createDshDecisionRunner,
  createOrchestratorForeground,
  createSdkDecisionRunner,
  defaultPatchPath,
  defaultSdkPatchPath,
  matchQuickRequest,
  parseDecision,
  parseQuickRequest,
} = await import('../lib/index.js')
const { createRuleForeground, createWfxmHost } = await import('@dsh-wfxm/host')

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
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'orchestrator-'))
const CLOCK = new Date('2026-11-11T10:00:00.000Z')
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
      const externalMsgId = `om_${sent.length + 1}`
      sent.push({ ...delivery, externalMsgId })
      return { externalMsgId }
    },
  }
}

/** One fresh host + DB per case; the foreground is built by the host's factory. */
function makeHost({ decide, fallback, logger, foreground, probe, checks } = {}) {
  hostSeq += 1
  const dbPath = join(dir, `orchestrator-${hostSeq}.sqlite`)
  const transport = makeTransport()
  const calls = []
  const host = createWfxmHost({
    dbPath,
    executor: (task) => {
      calls.push(task.id)
      return { status: 'succeeded', summary: 'executor ok' }
    },
    transport,
    now,
    ...foreground === undefined
      ? {
          foregroundFactory: ({ tasks }) => createOrchestratorForeground({
            tasks,
            decide: decide ?? (async () => '{"action":"reply","text":"ok"}'),
            // `fallback: null` means "no downgrade path" (loud failure case).
            ...fallback === null
              ? {}
              : { fallback: fallback ?? createRuleForeground({ tasks }) },
            logger: logger ?? null,
            ...probe === undefined ? {} : { probe },
            ...checks === undefined ? {} : { checks },
          }),
        }
      : { foreground },
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
  const input = {
    channelId: CHANNEL,
    msgId: options.msgId ?? uniqueMsg('m'),
    externalUserId: options.externalUserId ?? 'ou_owner',
    content: options.content ?? { text },
    chatId: options.chatId ?? CHAT,
  }
  const result = await host.ingest(input)
  return { result, msgId: input.msgId }
}

// ---- 决策解析：模型输出是不可信文本 -------------------------------------------------

await check('a fenced reply decision parses into a reply', () => {
  const parsed = parseDecision('好的：\n```json\n{"action":"reply","text":"我在。"}\n```')
  return parsed.ok && parsed.decision.action === 'reply' && parsed.decision.text === '我在。'
})

await check('a task decision keeps its intent and explicit R0', () => {
  const parsed = parseDecision('{"action":"task","intent":"查看磁盘占用","risk":"R0"}')
  return parsed.ok && parsed.decision.action === 'task' && parsed.decision.risk === 'R0'
})

await check('a task decision without risk defaults to R1', () => {
  const parsed = parseDecision('{"action":"task","intent":"清理日志"}')
  return parsed.ok && parsed.decision.action === 'task' && parsed.decision.risk === 'R1'
})

await check('R2 / R3 are rejected: the front desk may not raise the level', () => {
  const r2 = parseDecision('{"action":"task","intent":"重启服务","risk":"R2"}')
  const r3 = parseDecision('{"action":"task","intent":"发邮件","risk":"R3"}')
  return !r2.ok && r2.reason === 'risk-not-allowed'
    && !r3.ok && r3.reason === 'risk-not-allowed'
})

await check('unknown action / malformed JSON / empty intent are rejected', () => {
  const unknown = parseDecision('{"action":"execute","command":"rm -rf /"}')
  const broken = parseDecision('sure, I will look into it')
  const empty = parseDecision('{"action":"task","intent":"   "}')
  return !unknown.ok && unknown.reason === 'unknown-action'
    && !broken.ok && broken.reason === 'not-json'
    && !empty.ok && empty.reason === 'intent-empty'
})

await check('queue is rejected when the thread has no live task', () => {
  const parsed = parseDecision('{"action":"queue","text":"顺便看看内存"}', { liveTask: false })
  return !parsed.ok && parsed.reason === 'queue-without-task'
})

await check('oversized reply / intent are rejected before reaching ⑤', () => {
  const reply = parseDecision(JSON.stringify({ action: 'reply', text: 'x'.repeat(4001) }))
  const intent = parseDecision(JSON.stringify({ action: 'task', intent: 'y'.repeat(501) }))
  return !reply.ok && reply.reason === 'reply-too-long'
    && !intent.ok && intent.reason === 'intent-too-long'
})

// ---- 提示：只装最少上下文，零产品/协议名 ----------------------------------------------

await check('the prompt carries text, project and live task, and no plugin/protocol names', () => {
  const prompt = buildDecisionPrompt({
    text: '顺便看看内存',
    projectName: 'dsh-wfxm',
    liveTask: { id: 't1', status: 'running', intent: '查看磁盘占用' },
  })
  const leaked = /feishu|open_id|task_submit|@dsh-wfxm|sqlite|outbox/i.test(prompt)
  return prompt.includes('顺便看看内存')
    && prompt.includes('running')
    && prompt.includes('查看磁盘占用')
    && !leaked
})

await check('the prompt carries recent history in order and tells the model to resolve references', () => {
  const prompt = buildDecisionPrompt({
    text: '那它现在呢？',
    history: [
      { role: 'user', text: '看看 demo 服务' },
      { role: 'assistant', text: 'demo 服务运行中' },
    ],
  })
  return prompt.includes('最近对话')
    && prompt.indexOf('看看 demo 服务') < prompt.indexOf('demo 服务运行中')
    && prompt.includes('指代')
})

await check('a decision turn is scoped to the thread id, never a shared session', async () => {
  const keys = []
  const { host } = makeHost({
    decide: async (_prompt, sessionKey) => {
      keys.push(sessionKey)
      return '{"action":"reply","text":"好的"}'
    },
  })
  await pair(host)
  const { result } = await say(host, '你好')
  await host.pump()
  const threadId = result.result.thread?.id ?? null
  host.close()
  return threadId !== null && keys.length === 1 && keys[0] === threadId
})

// ---- 快问直答：只读问题不跑模型、不建任务 -------------------------------------------

const SNAPSHOT = { diskUsedPct: 42, memAvailablePct: 61, load1: 0.42, cpuCores: 8 }

await check('a read-only resource question is answered by the probe, not the model', async () => {
  let decided = 0
  const { host, transport, calls } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
    probe: async () => SNAPSHOT,
  })
  await pair(host)
  const { result } = await say(host, '看看磁盘占用')
  const tasks = host.stores.tasks.listTasks()
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  const decisions = host.stores.gateway.listRouteDecisions({ triggerId: result.result.inbox.id })
  host.close()
  const answer = outbound.find((text) => text.includes('磁盘已用'))
  return result.foreground?.action === 'reply'
    && result.foreground.note === 'quick-answer:resources'
    && answer === '磁盘已用 42% · 内存可用 61% · 负载 0.42（8 核）'
    && decided === 0
    && tasks.length === 0
    && calls.length === 0
    && decisions.some((row) => row.reason === 'quick-answer:resources')
})

await check('a probe that cannot read anything falls through to the model', async () => {
  let decided = 0
  const { host } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"task","intent":"检查磁盘占用","risk":"R0"}'
    },
    probe: async () => ({ diskUsedPct: null, memAvailablePct: null, load1: null, cpuCores: 8 }),
  })
  await pair(host)
  const { result } = await say(host, '看看磁盘占用')
  host.close()
  return decided === 1 && result.foreground?.action === 'task-created'
})

await check('no probe configured means the model keeps deciding', async () => {
  let decided = 0
  const { host } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"task","intent":"检查磁盘占用","risk":"R0"}'
    },
  })
  await pair(host)
  await say(host, '看看磁盘占用')
  host.close()
  return decided === 1
})

await check('an action verb is never answered with a probe', async () => {
  let decided = 0
  const { host } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"task","intent":"清理磁盘空间","risk":"R1"}'
    },
    probe: async () => SNAPSHOT,
  })
  await pair(host)
  const { result } = await say(host, '把磁盘清理一下')
  host.close()
  return decided === 1 && result.foreground?.action === 'task-created'
})

await check('the rule layer raises an R1 service restart to R3 with a template assertion', async () => {
  const { host } = makeHost({
    decide: async () => '{"action":"task","intent":"重启 demo 服务","risk":"R1"}',
  })
  await pair(host)
  const { result } = await say(host, '重启 demo 服务')
  const taskId = result.foreground?.taskId
  const task = host.stores.tasks.getTask(taskId)
  const assertions = host.stores.tasks.listAssertions(taskId)
  host.close()

  return result.foreground?.action === 'task-created'
    && result.foreground.note === 'risk-escalated:svc-start:dsh-wfxm-managed-demo.service'
    && task.riskLevel === 'R3'
    && assertions.length === 2
    && assertions[0].kind === 'unit_restarted'
    && assertions[1].kind === 'service_active'
    && assertions.every((item) => item.spec.unit === 'dsh-wfxm-managed-demo.service')
})

await check('a read-only log request about a managed unit is not escalated', async () => {
  const { host } = makeHost({
    decide: async () => JSON.stringify({
      action: 'task',
      intent: '取 dsh-wfxm-managed-demo.service 最近 50 行 journal 日志，检查其中是否有报错，并判断该服务启动是否正常，回报结果。',
      risk: 'R1',
    }),
  })
  await pair(host)
  const { result } = await say(host, '看日志')
  const task = host.stores.tasks.getTask(result.foreground?.taskId)
  host.close()
  return result.foreground?.action === 'task-created'
    && task.riskLevel === 'R1'
    && task.status === 'queued'
})

await check('a progress question is answered from ⑤ without a decision run', async () => {
  let decided = 0
  const { host, transport } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
  })
  await pair(host)
  const task = host.stores.tasks.createTask({ intent: '查看磁盘占用', riskLevel: 'R0', originMsgId: 'm_progress' })
  const thread = host.stores.gateway.resolveThread({ channelId: CHANNEL, chatId: CHAT, rootMsgId: 'm_progress' })
  host.stores.tasks.bindThread({
    taskId: task.id,
    threadId: thread.id,
    relation: 'default_owner',
    anchorMsgId: 'm_progress',
  })
  const foreground = createOrchestratorForeground({
    tasks: host.stores.tasks,
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
  })
  const outcome = await foreground({
    result: {
      target: { kind: 'orchestrator' },
      duplicate: false,
      thread,
      project: null,
      inbox: { id: 'inbox_progress', msgId: 'm_progress' },
    },
    text: '看看任务进度',
  })
  host.close()
  return outcome.action === 'reply'
    && outcome.text.includes(task.taskRef)
    && outcome.text.includes('查看磁盘占用')
    && outcome.note === 'quick-answer:tasks'
    && decided === 0
    && transport.sent.length === 0
})

await check('writing to an absolute file is escalated to R2 with file_exists', async () => {
  const { host } = makeHost({
    decide: async () => JSON.stringify({
      action: 'task',
      intent: '把结果写入 /var/lib/dsh-wfxm/workspace/notes/r2-demo.txt',
      risk: 'R1',
    }),
  })
  await pair(host)
  const { result } = await say(host, '写文件')
  const task = host.stores.tasks.getTask(result.foreground?.taskId)
  const assertions = host.stores.tasks.listAssertions(task.id)
  host.close()
  return result.foreground?.action === 'task-created'
    && task.riskLevel === 'R2'
    && assertions.length === 1
    && assertions[0].kind === 'file_exists'
    && assertions[0].spec.path === '/var/lib/dsh-wfxm/workspace/notes/r2-demo.txt'
})

await check('a relative write path stays at its baseline risk', async () => {
  const { host } = makeHost({
    decide: async () => JSON.stringify({ action: 'task', intent: '把结果写入 report.md', risk: 'R1' }),
  })
  await pair(host)
  const { result } = await say(host, '写文件')
  const task = host.stores.tasks.getTask(result.foreground?.taskId)
  const assertions = host.stores.tasks.listAssertions(task.id)
  host.close()
  return result.foreground?.action === 'task-created'
    && task.riskLevel === 'R1'
    && assertions.length === 0
})

await check('a paused (rejected) task does not absorb later messages', async () => {
  const { host } = makeHost({ decide: async () => '{"action":"reply","text":"不该走到这里"}' })
  await pair(host)
  const thread = host.stores.gateway.resolveThread({ channelId: CHANNEL, chatId: CHAT, rootMsgId: 'm_rejected' })
  const parked = host.stores.tasks.createTask({ intent: '重启 nginx', riskLevel: 'R1', originMsgId: 'm_rejected' })
  host.stores.tasks.bindThread({
    taskId: parked.id,
    threadId: thread.id,
    relation: 'default_owner',
    anchorMsgId: 'm_rejected',
  })
  host.stores.tasks.transition(parked.id, { to: 'running', reason: 'manual' })
  host.stores.tasks.transition(parked.id, { to: 'paused', reason: 'approval-rejected' })

  const foreground = createOrchestratorForeground({
    tasks: host.stores.tasks,
    decide: async () => '{"action":"task","intent":"看看磁盘占用","risk":"R0"}',
  })
  const outcome = await foreground({
    result: {
      target: { kind: 'orchestrator' },
      duplicate: false,
      thread,
      project: null,
      inbox: { id: 'inbox_rejected', msgId: 'm_rejected_2' },
    },
    text: '看看磁盘占用',
  })
  const created = host.stores.tasks.getTask(outcome.taskId ?? '')
  host.close()
  return outcome.action === 'task-created'
    && created !== null
    && created.id !== parked.id
    && created.status === 'queued'
})

await check('a named managed unit is answered from ⑦ without a decision run', async () => {
  let decided = 0
  let asked = null
  const { host, transport, calls } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
    checks: {
      unitStatus: async (unit) => {
        asked = unit
        return 'active'
      },
    },
  })
  await pair(host)
  const { result } = await say(host, '看看 dsh-wfxm-managed-demo 服务状态')
  const tasks = host.stores.tasks.listTasks()
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.action === 'reply'
    && result.foreground.note === 'quick-answer:units'
    && asked === 'dsh-wfxm-managed-demo.service'
    && outbound.some((text) => text.includes('dsh-wfxm-managed-demo.service') && text.includes('运行中'))
    && decided === 0
    && tasks.length === 0
    && calls.length === 0
})

await check('a short service name maps onto the managed unit convention', async () => {
  let asked = null
  const { host, transport } = makeHost({
    checks: {
      unitStatus: async (unit) => {
        asked = unit
        return 'inactive'
      },
    },
  })
  await pair(host)
  const { result } = await say(host, 'demo 服务在跑吗')
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.note === 'quick-answer:units'
    && asked === 'dsh-wfxm-managed-demo.service'
    && outbound.some((text) => text.includes('未运行'))
})

await check('a port question answers both listening and not-listening states', async () => {
  let decided = 0
  const { host, transport } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
    checks: { listeningPorts: async () => [8080, 443] },
  })
  await pair(host)
  const first = await say(host, '8080 端口在监听吗')
  const second = await say(host, '9090 端口通吗')
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return first.result.foreground?.note === 'quick-answer:ports'
    && second.result.foreground?.note === 'quick-answer:ports'
    && outbound.some((text) => text.includes('端口 8080：正在监听'))
    && outbound.some((text) => text.includes('端口 9090：没有监听'))
    && decided === 0
})

await check('a log error question uses the requested window and never guesses', async () => {
  let askedMinutes = null
  const { host, transport } = makeHost({
    checks: {
      logErrors: async (minutes) => {
        askedMinutes = minutes
        return 3
      },
    },
  })
  await pair(host)
  const { result } = await say(host, '最近 5 分钟错误日志多少条')
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.note === 'quick-answer:logs'
    && askedMinutes === 5
    && outbound.some((text) => text === '最近 5 分钟错误日志 3 条（journalctl -p err）。')
})

await check('missing checks fall through to the model instead of a guess', async () => {
  let decided = 0
  const { host } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"模型回答"}'
    },
  })
  await pair(host)
  const { result } = await say(host, '8080 端口在监听吗')
  host.close()
  return decided === 1 && result.foreground?.action === 'reply'
})

await check('unit/port/log matching stays conservative', () => {
  return parseQuickRequest('看看服务状态') === null
    && parseQuickRequest('看看今天的错误日志') === null
    && parseQuickRequest('重启 demo 服务') === null
    && parseQuickRequest('demo 服务在跑吗')?.unit === 'dsh-wfxm-managed-demo.service'
    && parseQuickRequest('8080 端口通吗')?.port === 8080
})

await check('quick matching stays conservative: ambiguity and actions are excluded', () => {
  return matchQuickRequest('看看磁盘占用') === 'resources'
    && matchQuickRequest('内存还剩多少') === 'resources'
    && matchQuickRequest('看看任务进度') === 'tasks'
    && matchQuickRequest('磁盘满了怎么办') === null
    && matchQuickRequest('重启一下服务，然后看看磁盘') === null
    && matchQuickRequest(`${'看看磁盘占用'}，顺便帮我检查一下所有服务的状态和日志里有没有报错`) === null
})

// ---- 前台接缝：reply 不建任务，task 建任务但不执行 ------------------------------------

await check('a chat message is answered directly: no task, one outbound, zero execution', async () => {
  const seen = []
  const { host, transport, calls } = makeHost({
    decide: async (prompt) => {
      seen.push(prompt)
      return '{"action":"reply","text":"你好，我在。"}'
    },
  })
  await pair(host)
  const { result } = await say(host, '你好')
  const tasks = host.stores.tasks.listTasks()
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.action === 'reply'
    && result.foreground.text === '你好，我在。'
    && seen.length === 1 && seen[0].includes('你好')
    && tasks.length === 0
    && calls.length === 0
    && outbound.includes('你好，我在。')
})

await check('a work request becomes one R0 task bound to the thread, still no execution', async () => {
  const { host, transport, calls } = makeHost({
    decide: async () => '{"action":"task","intent":"查看磁盘占用","risk":"R0"}',
  })
  await pair(host)
  const { result } = await say(host, '看看磁盘占用')
  const tasks = host.stores.tasks.listTasks()
  const task = tasks[0]
  const bindings = host.stores.tasks.listTaskThreads({ threadId: result.result.thread.id, liveOnly: true })
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.action === 'task-created'
    && tasks.length === 1
    && task.intent === '查看磁盘占用'
    && task.riskLevel === 'R0'
    && task.status === 'queued'
    && bindings.length === 1
    && bindings[0].taskId === task.id
    && bindings[0].relation === 'default_owner'
    && calls.length === 0
    && outbound.some((text) => text.includes(task.taskRef))
})

await check('a work request while a task is live is queued as input, not a second task', async () => {
  const { host } = makeHost()
  await pair(host)
  const task = host.stores.tasks.createTask({ intent: '查看磁盘占用', riskLevel: 'R1', originMsgId: 'm_live' })
  const thread = host.stores.gateway.resolveThread({
    channelId: CHANNEL,
    chatId: CHAT,
    rootMsgId: 'm_live',
  })
  host.stores.tasks.bindThread({
    taskId: task.id,
    threadId: thread.id,
    relation: 'default_owner',
    anchorMsgId: 'm_live',
  })

  const foreground = createOrchestratorForeground({
    tasks: host.stores.tasks,
    decide: async () => '{"action":"task","intent":"再查一下内存"}',
  })
  const outcome = await foreground({
    result: {
      target: { kind: 'orchestrator' },
      duplicate: false,
      thread,
      project: null,
      inbox: { id: 'inbox_synthetic', msgId: 'm_synthetic' },
    },
    text: '再查一下内存',
  })
  const tasks = host.stores.tasks.listTasks()
  const inputs = host.stores.tasks.pendingInputs(task.id)
  host.close()
  return outcome.action === 'input-queued'
    && outcome.taskId === task.id
    && tasks.length === 1
    && inputs.length === 1
    && inputs[0].inboxId === 'inbox_synthetic'
})

// ---- 降级：失败/被拒 → 规则前台，且留痕 ----------------------------------------------

await check('a throwing decision run degrades to the rule foreground with a note', async () => {
  const warnings = []
  const { host } = makeHost({
    decide: async () => {
      throw new Error('dsh binary not found: dsh')
    },
    logger: { warn: (message) => warnings.push(message) },
  })
  await pair(host)
  const { result } = await say(host, '把日志清理一下')
  const tasks = host.stores.tasks.listTasks()
  const decisions = host.stores.gateway.listRouteDecisions({ triggerId: result.result.inbox.id })
  host.close()
  const note = decisions.find((row) => row.reason.startsWith('orchestrator-fallback:'))
  return result.foreground?.action === 'task-created'
    && result.foreground.note?.startsWith('orchestrator-fallback: decision-failed:')
    && tasks.length === 1
    && tasks[0].riskLevel === 'R1'
    && note !== undefined
    && warnings.some((line) => line.includes('orchestrator-fallback'))
})

await check('an inflated R3 decision degrades instead of creating an R3 task', async () => {
  const { host } = makeHost({ decide: async () => '{"action":"task","intent":"重启服务","risk":"R3"}' })
  await pair(host)
  const { result } = await say(host, '重启一下 nginx')
  const tasks = host.stores.tasks.listTasks()
  host.close()
  return result.foreground?.action === 'task-created'
    && result.foreground.note === 'orchestrator-fallback: risk-not-allowed'
    && tasks.length === 1
    && tasks[0].riskLevel === 'R1'
})

await check('no fallback configured means a loud failure, not a dropped message', async () => {
  const { host } = makeHost({ decide: async () => 'not json at all' })
  // Rebuild the same DB host without a fallback is not possible; assert the
  // handler contract directly instead.
  const foreground = createOrchestratorForeground({
    tasks: host.stores.tasks,
    decide: async () => 'not json at all',
  })
  let threw = false
  try {
    await foreground({
      result: {
        target: { kind: 'orchestrator' },
        duplicate: false,
        thread: { id: 'thread_unknown' },
        project: null,
        inbox: { id: 'inbox_x', msgId: 'm_x' },
      },
      text: '随便',
    })
  } catch (error) {
    threw = String(error).includes('orchestrator-fallback: not-json')
  }
  host.close()
  return threw
})

await check('a dangling decision with no fallback marks the inbox failed (host AR13)', async () => {
  const { host } = makeHost({
    foreground: createOrchestratorForeground({
      tasks: { listTaskThreads: () => [], getTask: () => null },
      decide: async () => '{"action":"task","intent":""}',
    }),
  })
  await pair(host)
  const { result } = await say(host, '做点什么')
  const inbox = host.stores.gateway.getInbox(result.result.inbox.id)
  host.close()
  return result.error === 'foreground-unavailable'
    && inbox !== null
    && inbox.status === 'failed'
    && inbox.errorCode === 'foreground-unavailable'
})

// ---- 非文本 / 重复 / 非前台目标：不起决策 --------------------------------------------

await check('non-text input replies without spending a decision run', async () => {
  let decided = 0
  const { host, transport } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"不该走到这里"}'
    },
  })
  await pair(host)
  const { result } = await say(host, null, { content: { fileKey: 'f_1' } })
  await host.pump()
  const outbound = transport.sent.map((item) => item.payload.text)
  host.close()
  return result.foreground?.action === 'reply'
    && result.foreground.text === NON_TEXT_REPLY
    && decided === 0
    && outbound.includes(NON_TEXT_REPLY)
})

await check('a replayed message never reaches the decision run twice', async () => {
  let decided = 0
  const { host } = makeHost({
    decide: async () => {
      decided += 1
      return '{"action":"reply","text":"收到"}'
    },
  })
  await pair(host)
  const msgId = uniqueMsg('dup')
  await say(host, '你好', { msgId })
  const second = await say(host, '你好', { msgId })
  host.close()
  return decided === 1 && second.result.result.duplicate === true && second.result.foreground === null
})

// ---- runner：dsh 调用形状 / 超时 / 崩溃 / 缺二进制 ------------------------------------

const stubPath = join(pkgRoot, 'scripts', 'stub-dsh.mjs')
chmodSync(stubPath, 0o755)
const recordPath = join(dir, 'record.json')

await check('the runner invokes dsh with the tool-less overlay and read-only mode', async () => {
  const runner = createDshDecisionRunner({ dshBin: stubPath, env: { STUB_DSH_RECORD: recordPath } })
  const text = await runner('decide this')
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const patch = defaultPatchPath()
  return text.trim() === '{"action":"reply","text":"stub"}'
    && record.argv.join(' ') === `--profile headless --patch ${patch} --json -`
    && record.permissionMode === 'read-only'
    && existsSync(patch)
})

await check('a slow decision run times out instead of hanging the turn', async () => {
  const runner = createDshDecisionRunner({
    dshBin: stubPath,
    timeoutMs: 300,
    env: { STUB_DSH_MODE: 'sleep', STUB_DSH_SLEEP_MS: '5000', STUB_DSH_RECORD: recordPath },
  })
  try {
    await runner('slow')
    return false
  } catch (error) {
    return String(error).includes('timed out')
  }
})

await check('a crashed dsh surfaces stderr, it does not look like a decision', async () => {
  const runner = createDshDecisionRunner({
    dshBin: stubPath,
    env: { STUB_DSH_MODE: 'crash', STUB_DSH_STDERR: 'boom from dsh', STUB_DSH_RECORD: recordPath },
  })
  try {
    await runner('crash')
    return false
  } catch (error) {
    return String(error).includes('code 3') && String(error).includes('boom from dsh')
  }
})

await check('a turn_end error event rejects even when dsh exits 0', async () => {
  const runner = createDshDecisionRunner({
    dshBin: stubPath,
    env: { STUB_DSH_MODE: 'error', STUB_DSH_RECORD: recordPath },
  })
  try {
    await runner('error')
    return false
  } catch (error) {
    return String(error).includes('STUB_ERROR')
  }
})

await check('a missing dsh binary says so instead of degrading silently', async () => {
  const runner = createDshDecisionRunner({ dshBin: join(dir, 'no-such-dsh') })
  try {
    await runner('x')
    return false
  } catch (error) {
    return String(error).includes('dsh binary not found')
  }
})

// ---- 切片 F：常驻会话（一次装配，多轮复用） --------------------------------------

function makeFakeTurn(options = {}) {
  const { answers = [], delayMs = 0, hang = false, failAt = -1 } = options
  const turn = {
    starts: 0,
    closes: 0,
    asks: [],
    concurrent: 0,
    maxConcurrent: 0,
    async start() {
      turn.starts++
    },
    async ask(prompt) {
      turn.asks.push(prompt)
      turn.concurrent++
      turn.maxConcurrent = Math.max(turn.maxConcurrent, turn.concurrent)
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (hang) await new Promise(() => {})
        if (turn.asks.length - 1 === failAt) throw new Error('runtime died')
        return answers[turn.asks.length - 1] ?? 'ok'
      } finally {
        turn.concurrent--
      }
    },
    async close() {
      turn.closes++
    },
  }
  return turn
}

await check('the resident runtime boots once and answers every later turn', async () => {
  const turn = makeFakeTurn({ answers: ['a', 'b', 'c'] })
  const decide = createSdkDecisionRunner({ createTurn: () => turn, timeoutMs: 2_000 })
  await decide.warm()
  const first = await decide('one')
  const second = await decide('two')
  const third = await decide('three')
  await decide.close()
  return first === 'a'
    && second === 'b'
    && third === 'c'
    && turn.starts === 1
    && turn.asks.length === 3
    && turn.closes === 1
})

await check('concurrent turns are serialised on the one resident runtime', async () => {
  const turn = makeFakeTurn({ answers: ['a', 'b'], delayMs: 30 })
  const decide = createSdkDecisionRunner({ createTurn: () => turn, timeoutMs: 5_000 })
  const results = await Promise.all([decide('one'), decide('two')])
  await decide.close()
  return results.join(',') === 'a,b' && turn.maxConcurrent === 1 && turn.starts === 1
})

await check('a timeout discards the runtime; the next turn boots a clean one', async () => {
  const hung = makeFakeTurn({ hang: true })
  const fresh = makeFakeTurn({ answers: ['ok'] })
  const created = [hung, fresh]
  let made = 0
  const decide = createSdkDecisionRunner({
    createTurn: () => created[made++],
    timeoutMs: 100,
  })
  try {
    await decide('slow')
    return false
  } catch (error) {
    if (!String(error).includes('timed out')) return false
  }
  const after = await decide('next')
  await decide.close()
  return after === 'ok' && made === 2 && hung.closes === 1 && fresh.starts === 1
})

await check('a failed turn is surfaced and never reuses the failed session', async () => {
  const broken = makeFakeTurn({ answers: ['x'], failAt: 0 })
  const fresh = makeFakeTurn({ answers: ['ok'] })
  const created = [broken, fresh]
  let made = 0
  const decide = createSdkDecisionRunner({ createTurn: () => created[made++], timeoutMs: 2_000 })
  try {
    await decide('boom')
    return false
  } catch (error) {
    if (!String(error).includes('runtime died')) return false
  }
  const after = await decide('next')
  await decide.close()
  return after === 'ok' && made === 2 && broken.closes === 1
})

await check('an empty decision is a failure, not an empty reply', async () => {
  const turn = makeFakeTurn({ answers: ['   '] })
  const decide = createSdkDecisionRunner({ createTurn: () => turn, timeoutMs: 2_000 })
  try {
    await decide('x')
    return false
  } catch (error) {
    return String(error).includes('no text') && turn.closes === 1
  }
})

await check('a closed runner rejects later turns instead of resurrecting', async () => {
  const turn = makeFakeTurn({ answers: ['a'] })
  const decide = createSdkDecisionRunner({ createTurn: () => turn, timeoutMs: 1_000 })
  await decide('one')
  await decide.close()
  try {
    await decide('two')
    return false
  } catch (error) {
    return String(error).includes('closed') && turn.closes === 1
  }
})

await check('the factory defaults to the resident runtime and rejects unknown kinds', async () => {
  if (DEFAULT_DECISION_RUNNER !== 'sdk') return false
  try {
    createDecisionRunner({ kind: 'nope' })
    return false
  } catch (error) {
    if (!String(error).includes('unknown decision runner')) return false
  }
  const headless = createDecisionRunner({ kind: 'headless', timeoutMs: 1_000 })
  await headless.warm()
  await headless.close()
  return typeof headless === 'function'
    && typeof headless.warm === 'function'
    && typeof headless.close === 'function'
})

// ---- 资产与静态边界 ----------------------------------------------------------------

await check('the overlay strips every model-facing tool and sets the persona', () => {
  const yml = readFileSync(defaultPatchPath(), 'utf8')
  const ids = ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-skill', 'tool-subagent']
  return ids.every((id) => yml.includes(`id: ${id}`))
    && yml.includes('disabled: true')
    && yml.includes('personaPrefix')
    && !yml.includes('if:')
})

await check('the sdk overlay also strips plan-mode, the last tool registrant', () => {
  const yml = readFileSync(defaultSdkPatchPath(), 'utf8')
  const ids = [
    'tool-bash',
    'tool-fs',
    'tool-fs-search',
    'tool-web',
    'tool-skill',
    'tool-subagent',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-plugin-manager',
    'plan-mode',
  ]
  return ids.every((id) => yml.includes(`id: ${id}`))
    && yml.includes('personaPrefix')
    && !yml.includes('tool-agent-team')
})

let dshOnPath = true
try {
  execFileSync('dsh', ['--version'], { stdio: 'ignore' })
} catch {
  dshOnPath = false
}

await check('no model-facing tool survives either overlay (real --dump-config)', () => {
  if (!dshOnPath) {
    console.log('  (skipped: dsh not on PATH)')
    return true
  }
  // `tool-result-pruner` is not a model tool: it trims tool results after the
  // fact and registers nothing the model can call.
  const allow = new Set(['tool-result-pruner'])
  const env = { ...process.env }
  delete env.LD_LIBRARY_PATH
  const overlays = [
    ['sdk', defaultSdkPatchPath()],
    ['headless', defaultPatchPath()],
  ]
  for (const [profile, patch] of overlays) {
    const dumped = execFileSync(
      'dsh',
      ['--profile', profile, '--patch', patch, '--dump-config'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, maxBuffer: 64 * 1024 * 1024 },
    )
    const entries = []
    for (const line of dumped.split('\n')) {
      const id = /^- id: (.*)$/.exec(line)
      if (id) {
        entries.push({ id: id[1].trim(), disabled: false })
        continue
      }
      if (entries.length > 0 && /^\s+disabled: true\s*$/.test(line)) {
        entries[entries.length - 1].disabled = true
      }
    }
    const leaked = entries
      .filter((entry) => entry.id.startsWith('tool-') && !entry.disabled && !allow.has(entry.id))
      .map((entry) => entry.id)
    if (leaked.length > 0) throw new Error(`${profile} still exposes: ${leaked.join(', ')}`)
  }
  return true
})

await check('src has no SQL, table or channel-protocol names (AR32/AR33)', () => {
  const srcDir = join(pkgRoot, 'src')
  const banned = /\b(SELECT|INSERT|UPDATE|DELETE FROM|sqlite|feishu|open_id|webhook|om_)\b/i
  const files = ['decision.ts', 'foreground.ts', 'prompt.ts', 'runner.ts', 'runner-factory.ts', 'sdk-runner.ts', 'index.ts']
  for (const file of files) {
    const body = readFileSync(join(srcDir, file), 'utf8')
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    if (banned.test(code)) throw new Error(`banned token in ${file}`)
  }
  return true
})

// ---- 汇总 ------------------------------------------------------------------------

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
assert.ok(pass > 0)
