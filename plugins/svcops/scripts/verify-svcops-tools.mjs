import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SVC_TOOL_PORT,
  SVC_TOOL_RISK,
  SvcOpsError,
  apply,
  registerSvcTools,
} from '../lib/index.js'

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

function makeAdapter({ detect = true, runtime = 'systemd' } = {}) {
  const calls = []
  return {
    calls,
    runtime,
    async detect() {
      calls.push('detect')
      return detect
    },
    async list() {
      calls.push('list')
      return [
        {
          unit: 'dsh-wfxm-managed-api.service',
          loadState: 'loaded',
          activeState: 'active',
          subState: 'running',
          description: 'dsh-wfxm api',
        },
      ]
    },
    async status(unit) {
      calls.push(`status:${unit}`)
      return {
        unit,
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        description: 'dsh-wfxm api',
        unitFileState: 'enabled',
        mainPid: 1234,
        activeEnterTimestamp: 'Wed 2026-11-04 10:00:00 CST',
        restarts: 0,
      }
    },
    async logs(unit, lines) {
      calls.push(`logs:${unit}:${lines}`)
      return { unit, lines: ['line one', 'line two'] }
    },
    async start(unit) {
      calls.push(`start:${unit}`)
      return { unit, action: 'start', changed: true }
    },
    async stop(unit) {
      calls.push(`stop:${unit}`)
      return { unit, action: 'stop', changed: true }
    },
    async restart(unit) {
      calls.push(`restart:${unit}`)
      return { unit, action: 'restart', changed: true }
    },
  }
}

function makeCtx({ outcome = 'allowed-once', withApproval = true } = {}) {
  const registered = []
  const requests = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    get(name) {
      if (name !== 'approval' || !withApproval) return undefined
      return {
        async request(req) {
          requests.push(req)
          return outcome
        },
      }
    },
  }
  return { ctx, registered, requests }
}

const UNIT = 'dsh-wfxm-managed-api.service'
const EXEC = { agent: { session: 'fake' }, callId: 'call-1' }

const { ctx, registered, requests } = makeCtx()
const adapter = makeAdapter()
registerSvcTools(ctx, { adapter })
const tools = new Map(registered.map((tool) => [tool.name, tool]))

await check('注册 8 个工具', () => Promise.resolve(registered.length === 8
  && ['svc_list', 'svc_status', 'svc_logs', 'svc_inspect', 'svc_report', 'svc_start', 'svc_stop', 'svc_restart'].every((name) => tools.has(name))))
await check('每个工具都有 schema 与 render', () => Promise.resolve(
  [...tools.values()].every((tool) => tool.parameters && tool.output?.schema && typeof tool.output.render === 'function')))
await check('风险基线：读 R0 / 写 R3', () => Promise.resolve(
  SVC_TOOL_RISK.svc_list === 'R0'
  && SVC_TOOL_RISK.svc_status === 'R0'
  && SVC_TOOL_RISK.svc_logs === 'R0'
  && SVC_TOOL_RISK.svc_inspect === 'R0'
  && SVC_TOOL_RISK.svc_report === 'R0'
  && SVC_TOOL_RISK.svc_start === 'R3'
  && SVC_TOOL_RISK.svc_stop === 'R3'
  && SVC_TOOL_RISK.svc_restart === 'R3'
  && SVC_TOOL_PORT === 'SvcOps'))
await check('svc_list 走适配器', async () => {
  const value = await tools.get('svc_list').execute({}, EXEC)
  return value.runtime === 'systemd' && value.services.length === 1 && adapter.calls.includes('list')
})
await check('svc_status 传 unit', async () => {
  const value = await tools.get('svc_status').execute({ unit: UNIT }, EXEC)
  return value.unit === UNIT && value.mainPid === 1234 && adapter.calls.includes(`status:${UNIT}`)
})
await check('svc_logs 传行数', async () => {
  const value = await tools.get('svc_logs').execute({ unit: UNIT, lines: 50 }, EXEC)
  return value.lines.length === 2 && adapter.calls.includes(`logs:${UNIT}:50`)
})
await check('svc_start 批准后执行', async () => {
  const value = await tools.get('svc_start').execute({ unit: UNIT }, EXEC)
  return value.action === 'start'
    && requests.at(-1).toolName === 'svc_start'
    && adapter.calls.includes(`start:${UNIT}`)
})
await check('svc_stop 批准后执行', async () => {
  const value = await tools.get('svc_stop').execute({ unit: UNIT }, EXEC)
  return value.action === 'stop' && adapter.calls.includes(`stop:${UNIT}`)
})
await check('svc_restart 批准后执行', async () => {
  const value = await tools.get('svc_restart').execute({ unit: UNIT }, EXEC)
  return value.action === 'restart' && adapter.calls.includes(`restart:${UNIT}`)
})

const dockerCtx = makeCtx()
const dockerAdapter = makeAdapter({ runtime: 'docker' })
registerSvcTools(dockerCtx.ctx, { adapter: dockerAdapter })
const dockerTools = new Map(dockerCtx.registered.map((tool) => [tool.name, tool]))
await check('docker 适配器接受容器 id 并审批后执行', async () => {
  const value = await dockerTools.get('svc_restart').execute({ unit: 'dsh-wfxm-managed-api' }, EXEC)
  return value.action === 'restart'
    && dockerAdapter.calls.includes('restart:dsh-wfxm-managed-api')
    && dockerCtx.requests.at(-1).toolName === 'svc_restart'
})
await check('docker 适配器拒绝 systemd unit 且不请求审批', async () => {
  const before = dockerCtx.requests.length
  let rejected = false
  try {
    await dockerTools.get('svc_start').execute({ unit: UNIT }, EXEC)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected && dockerCtx.requests.length === before && !dockerAdapter.calls.some((call) => call.startsWith('start:'))
})

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  const denied = makeCtx({ outcome })
  const deniedAdapter = makeAdapter()
  registerSvcTools(denied.ctx, { adapter: deniedAdapter })
  const deniedTools = new Map(denied.registered.map((tool) => [tool.name, tool]))
  await check(`${outcome} 时不执行写动作`, async () => {
    let threw = false
    try {
      await deniedTools.get('svc_start').execute({ unit: UNIT }, EXEC)
    } catch (error) {
      threw = String(error).includes(outcome)
    }
    return threw && denied.requests.length === 1 && !deniedAdapter.calls.includes(`start:${UNIT}`)
  })
}

await check('无审批服务时拒绝执行', async () => {
  const noApproval = makeCtx({ withApproval: false })
  const noApprovalAdapter = makeAdapter()
  registerSvcTools(noApproval.ctx, { adapter: noApprovalAdapter })
  const tool = noApproval.registered.find((item) => item.name === 'svc_stop')
  let message = ''
  try {
    await tool.execute({ unit: UNIT }, EXEC)
  } catch (error) {
    message = String(error)
  }
  return message.includes('no approval service') && !noApprovalAdapter.calls.includes(`stop:${UNIT}`)
})

await check('无 agent 时拒绝执行', async () => {
  const withApproval = makeCtx()
  const agentlessAdapter = makeAdapter()
  registerSvcTools(withApproval.ctx, { adapter: agentlessAdapter })
  const tool = withApproval.registered.find((item) => item.name === 'svc_restart')
  let message = ''
  try {
    await tool.execute({ unit: UNIT }, { callId: 'call-2' })
  } catch (error) {
    message = String(error)
  }
  return message.includes('agent session') && !agentlessAdapter.calls.includes(`restart:${UNIT}`)
})

await check('非托管 unit 在审批前拒绝', async () => {
  const guard = makeCtx()
  const guardAdapter = makeAdapter()
  registerSvcTools(guard.ctx, { adapter: guardAdapter })
  const tool = guard.registered.find((item) => item.name === 'svc_start')
  let rejected = false
  try {
    await tool.execute({ unit: 'ssh.service' }, EXEC)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected && guard.requests.length === 0 && guardAdapter.calls.length === 0
})

await check('runtime 不可用时拒绝', async () => {
  const down = makeCtx()
  const downAdapter = makeAdapter({ detect: false })
  registerSvcTools(down.ctx, { adapter: downAdapter })
  const tool = down.registered.find((item) => item.name === 'svc_list')
  let rejected = false
  try {
    await tool.execute({}, EXEC)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'unavailable'
  }
  return rejected && !downAdapter.calls.includes('list')
})

await check('render 产出文本块', () => {
  const tool = tools.get('svc_status')
  const blocks = tool.output.render({ unit: UNIT }, {
    unit: UNIT,
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    description: 'dsh-wfxm api',
    unitFileState: 'enabled',
    mainPid: 1234,
    activeEnterTimestamp: null,
    restarts: 0,
  })
  return blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.includes(UNIT)
})

const CONTAINER = 'dsh-wfxm-managed-api'

const routingCtx = makeCtx()
const routedSystemd = makeAdapter()
const routedDocker = makeAdapter({ runtime: 'docker' })
registerSvcTools(routingCtx.ctx, { adapters: [routedSystemd, routedDocker] })
const routingTools = new Map(routingCtx.registered.map((tool) => [tool.name, tool]))

await check('多运行时按 unit 路由到唯一适配器', async () => {
  await routingTools.get('svc_status').execute({ unit: UNIT }, EXEC)
  await routingTools.get('svc_status').execute({ unit: CONTAINER }, EXEC)
  return routedSystemd.calls.includes(`status:${UNIT}`)
    && !routedSystemd.calls.includes(`status:${CONTAINER}`)
    && routedDocker.calls.includes(`status:${CONTAINER}`)
    && !routedDocker.calls.includes(`status:${UNIT}`)
})

await check('多运行时下未知 id 在审批前拒绝', async () => {
  const before = routingCtx.requests.length
  let rejected = false
  try {
    await routingTools.get('svc_start').execute({ unit: 'ssh.service' }, EXEC)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'not-allowed'
  }
  return rejected && routingCtx.requests.length === before
})

await check('svc_list 合并可用运行时', async () => {
  const value = await routingTools.get('svc_list').execute({}, EXEC)
  return value.runtime === 'systemd+docker' && value.services.length === 2
})

await check('svc_list 摘除缺失的运行时', async () => {
  const listCtx = makeCtx()
  const onlySystemd = makeAdapter()
  const noDocker = makeAdapter({ runtime: 'docker', detect: false })
  registerSvcTools(listCtx.ctx, { adapters: [onlySystemd, noDocker] })
  const tool = listCtx.registered.find((item) => item.name === 'svc_list')
  const value = await tool.execute({}, EXEC)
  return value.runtime === 'systemd'
    && value.services.length === 1
    && !noDocker.calls.includes('list')
})

await check('两个运行时都不可用时 svc_list 拒绝', async () => {
  const downCtx = makeCtx()
  registerSvcTools(downCtx.ctx, {
    adapters: [
      makeAdapter({ detect: false }),
      makeAdapter({ runtime: 'docker', detect: false }),
    ],
  })
  const tool = downCtx.registered.find((item) => item.name === 'svc_list')
  let rejected = false
  try {
    await tool.execute({}, EXEC)
  } catch (error) {
    rejected = error instanceof SvcOpsError && error.code === 'unavailable'
  }
  return rejected
})

const smokeDir = mkdtempSync(join(tmpdir(), 'svcops-apply-'))
process.env.DSH_WFXM_AUDIT_DB = join(smokeDir, 'ops.sqlite')

await check('apply 挂载 systemd + docker 两个适配器并注册 8 个工具', () => {
  const applied = makeCtx()
  const effects = []
  applied.ctx.effect = (fn) => effects.push(fn)
  apply(applied.ctx)
  const names = applied.registered.map((tool) => tool.name)
  const disposers = effects.map((fn) => fn())
  return names.length === 8
    && names.includes('svc_inspect')
    && names.includes('svc_report')
    && effects.length === 1
    && disposers.every((dispose) => typeof dispose === 'function')
})

rmSync(smokeDir, { recursive: true, force: true })
delete process.env.DSH_WFXM_AUDIT_DB

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
