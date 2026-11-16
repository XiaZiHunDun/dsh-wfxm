import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CHECKLIST_ID,
  DEFAULT_THRESHOLDS,
  collectHostMetrics,
  createInspectionStore,
  createResourceProbe,
  evaluate,
  probeDisk,
  probeFailedUnits,
  probeListeningPorts,
  probeLogErrors,
  quietWindowMs,
  registerSvcTools,
} from '../lib/index.js'
import { withQuietWindow } from '@dsh-wfxm/notify'

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

const healthy = {
  diskUsedPct: 40,
  memAvailablePct: 60,
  cpuCores: 4,
  load1: 0.5,
  failedUnits: [],
  listeningPorts: [22, 443],
  logErrors: 1,
}

const byId = (report, id) => report.items.find((item) => item.id === id)

await check('resource probe reads disk through the runner and always reports cores', async () => {
  const runner = {
    async run(argv) {
      if (argv[0] !== 'df') return { code: 1, stdout: '', stderr: 'not found' }
      return {
        code: 0,
        stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 42 58 42% /\n',
        stderr: '',
      }
    },
  }
  const snapshot = await createResourceProbe({ runner })()
  return snapshot.diskUsedPct === 42
    && snapshot.cpuCores >= 1
    && (snapshot.memAvailablePct === null || (snapshot.memAvailablePct >= 0 && snapshot.memAvailablePct <= 100))
})

await check('a failing resource probe is fail-soft, it never throws or guesses', async () => {
  const runner = { async run() { throw new Error('df unavailable') } }
  const snapshot = await createResourceProbe({ runner })()
  return snapshot.diskUsedPct === null && snapshot.cpuCores >= 1
})

await check('healthy host is ok and keeps six checklist items', () => {
  const report = evaluate(healthy)
  return report.status === 'ok'
    && report.checklistId === DEFAULT_CHECKLIST_ID
    && report.items.map((item) => item.id).join(',') === 'disk,memory,load,units,ports,logs'
})

await check('disk warn and fail thresholds', () => {
  const warn = byId(evaluate({ ...healthy, diskUsedPct: 86 }), 'disk')
  const bad = byId(evaluate({ ...healthy, diskUsedPct: 95 }), 'disk')
  return warn?.status === 'warn' && bad?.status === 'fail'
})

await check('memory is graded on available percent (low = bad)', () => {
  const warn = byId(evaluate({ ...healthy, memAvailablePct: 12 }), 'memory')
  const bad = byId(evaluate({ ...healthy, memAvailablePct: 3 }), 'memory')
  return warn?.status === 'warn' && bad?.status === 'fail'
})

await check('load is normalised per core', () => {
  const warn = byId(evaluate({ ...healthy, cpuCores: 2, load1: 3.2 }), 'load')
  const bad = byId(evaluate({ ...healthy, cpuCores: 1, load1: 3.2 }), 'load')
  return warn?.status === 'warn' && bad?.status === 'fail'
})

await check('failed units always fail and list up to 10 names', () => {
  const report = evaluate({ ...healthy, failedUnits: ['a.service', 'b.service'] })
  const item = byId(report, 'units')
  return item?.status === 'fail' && item.value === '2' && item.detail === 'a.service, b.service'
    && report.status === 'fail'
})

await check('systemd absent -> units skipped, not ok', () => {
  const report = evaluate({ ...healthy, failedUnits: null })
  return byId(report, 'units')?.status === 'skipped' && report.status === 'ok'
})

await check('expected ports missing -> fail with detail', () => {
  const report = evaluate(healthy, DEFAULT_THRESHOLDS, [22, 8080])
  const item = byId(report, 'ports')
  return item?.status === 'fail' && item.detail === '缺失 8080' && report.status === 'fail'
})

await check('expected ports present -> ok', () => {
  const item = byId(evaluate({ ...healthy, listeningPorts: [22, 8080] }, DEFAULT_THRESHOLDS, [22, 8080]), 'ports')
  return item?.status === 'ok'
})

await check('log error rate thresholds', () => {
  const warn = byId(evaluate({ ...healthy, logErrors: 30 }), 'logs')
  const bad = byId(evaluate({ ...healthy, logErrors: 150 }), 'logs')
  return warn?.status === 'warn' && bad?.status === 'fail'
})

await check('all probes unreadable -> overall skipped', () => {
  const report = evaluate({
    diskUsedPct: null,
    memAvailablePct: null,
    cpuCores: 1,
    load1: null,
    failedUnits: null,
    listeningPorts: null,
    logErrors: null,
  })
  return report.status === 'skipped'
})

const runnerOf = (table) => ({
  async run(argv) {
    const key = Object.keys(table).find(
      (candidate) => argv.slice(0, candidate.split(' ').length).join(' ') === candidate,
    )
    const hit = key === undefined ? undefined : table[key]
    if (hit === undefined) return { code: 127, stdout: '', stderr: 'not found' }
    return hit
  },
})

await check('probeDisk parses df -P output', async () => {
  const value = await probeDisk(runnerOf({
    df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 420 580 42% /\n', stderr: '' },
  }))
  return value === 42
})

await check('probeDisk returns null when df is missing', async () => {
  return (await probeDisk(runnerOf({}))) === null
})

await check('probeFailedUnits extracts unit names and tolerates no systemd', async () => {
  const units = await probeFailedUnits(runnerOf({
    'systemctl --failed': { code: 0, stdout: 'api.service loaded failed failed x\n', stderr: '' },
  }))
  const missing = await probeFailedUnits(runnerOf({}))
  return units?.length === 1 && units[0] === 'api.service' && missing === null
})

await check('probeListeningPorts parses ss -ltnH and de-duplicates', async () => {
  const ports = await probeListeningPorts(runnerOf({
    'ss -ltnH': {
      code: 0,
      stdout: 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:443 0.0.0.0:*\nLISTEN 0 4096 [::]:443 [::]:*\n',
      stderr: '',
    },
  }))
  return JSON.stringify(ports) === JSON.stringify([22, 443])
})

await check('probeLogErrors counts non-empty lines and returns null without journal', async () => {
  const count = await probeLogErrors(runnerOf({
    journalctl: { code: 0, stdout: 'e1\ne2\n\n', stderr: '' },
  }), 60)
  const missing = await probeLogErrors(runnerOf({}), 60)
  return count === 2 && missing === null
})

await check('collectHostMetrics keeps unreadable sources as null', async () => {
  const metrics = await collectHostMetrics({ runner: runnerOf({}) })
  return metrics.diskUsedPct === null
    && metrics.load1 !== null            // /proc/loadavg is readable in CI
    && metrics.failedUnits === null
})

const dir = mkdtempSync(join(tmpdir(), 'svcops-inspect-'))
const storePath = join(dir, 'store.sqlite')
const toolDbPath = join(dir, 'inspect.sqlite')

await check('store persists and returns the latest report', () => {
  const store = createInspectionStore(storePath)
  const report = evaluate(healthy)
  const saved = store.save({
    checklistId: report.checklistId,
    target: 'host-a',
    status: report.status,
    items: report.items,
    ranAt: '2026-11-06T10:00:00.000Z',
  })
  const latest = store.latest()
  const byTarget = store.latest('host-a')
  store.close()
  return saved.id.length > 0
    && latest?.id === saved.id
    && byTarget?.items.length === 6
    && byTarget?.status === 'ok'
})

await check('svc_inspect registers as R0 and persists a report', async () => {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  const store = createInspectionStore(toolDbPath)
  const runner = runnerOf({
    df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 100 900 10% /\n', stderr: '' },
    'systemctl --failed': { code: 0, stdout: '', stderr: '' },
    'ss -ltnH': { code: 0, stdout: 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n', stderr: '' },
    journalctl: { code: 0, stdout: '', stderr: '' },
  })
  registerSvcTools(ctx, {
    inspections: store,
    runner,
    expectedPorts: [22],
  })
  const value = await tools.get('svc_inspect').execute({}, { agent: {}, callId: 'c1' })
  const latest = store.latest()
  store.close()
  return tools.has('svc_inspect')
    && value.status !== 'fail'
    && value.items.length === 6
    && value.alert?.level === 'silent'
    && value.alert.reasons.length === 0
    && value.delivery === null
    && latest?.ranAt === value.ranAt
})

await check('svc_inspect fails closed without a store', async () => {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  registerSvcTools(ctx, { runner: runnerOf({}) })
  try {
    await tools.get('svc_inspect').execute({}, { agent: {}, callId: 'c2' })
    return false
  } catch (error) {
    return /requires the inspections store/.test(String(error?.message))
  }
})

await check('immediate grade pushes p0 through the notify port', async () => {
  const tools = new Map()
  const warnings = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    logger: { warn: (message) => warnings.push(message) },
  }
  const store = createInspectionStore(join(dir, 'deliver.sqlite'))
  const calls = []
  const notifier = {
    transport: 'fake',
    async notify(level, message) {
      calls.push({ level, message })
      return { transport: 'fake', id: 'msg-1', deliveredAt: '2026-11-06T10:00:00.000Z' }
    },
  }
  registerSvcTools(ctx, {
    inspections: store,
    notifier,
    runner: runnerOf({
      df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 990 10 99% /\n', stderr: '' },
      'systemctl --failed': { code: 0, stdout: '', stderr: '' },
      'ss -ltnH': { code: 0, stdout: '', stderr: '' },
      journalctl: { code: 0, stdout: '', stderr: '' },
    }),
  })
  const tool = tools.get('svc_inspect')
  const value = await tool.execute({}, { agent: {}, callId: 'd1' })
  const rendered = tool.output.render({}, value)[0].text
  store.close()
  return value.alert.level === 'immediate'
    && value.delivery?.transport === 'fake'
    && value.delivery.id === 'msg-1'
    && calls.length === 1
    && calls[0].level === 'p0'
    && calls[0].message.key.startsWith('default-min-safe:')
    && calls[0].message.body.includes('根分区使用率: 99%')
    && rendered.includes('delivered fake p0 (msg-1)')
    && warnings.length === 0
})

await check('digest grade does not push', async () => {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  const store = createInspectionStore(join(dir, 'digest.sqlite'))
  const calls = []
  registerSvcTools(ctx, {
    inspections: store,
    notifier: {
      transport: 'fake',
      async notify(level, message) {
        calls.push({ level, message })
        return { transport: 'fake', id: 'msg-2', deliveredAt: '2026-11-06T10:00:00.000Z' }
      },
    },
    thresholds: { ...DEFAULT_THRESHOLDS, diskWarnPct: 10, diskFailPct: 99 },
    runner: runnerOf({
      df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n', stderr: '' },
      'systemctl --failed': { code: 0, stdout: '', stderr: '' },
      'ss -ltnH': { code: 0, stdout: '', stderr: '' },
      journalctl: { code: 0, stdout: '', stderr: '' },
    }),
  })
  const value = await tools.get('svc_inspect').execute({}, { agent: {}, callId: 'd2' })
  store.close()
  return value.alert.level === 'digest' && value.delivery === null && calls.length === 0
})

await check('delivery failure is logged and never fails the inspection', async () => {
  const tools = new Map()
  const warnings = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    logger: { warn: (message) => warnings.push(message) },
  }
  const store = createInspectionStore(join(dir, 'delivery-down.sqlite'))
  registerSvcTools(ctx, {
    inspections: store,
    notifier: {
      transport: 'fake',
      async notify() {
        throw new Error('upstream 503')
      },
    },
    runner: runnerOf({
      df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 990 10 99% /\n', stderr: '' },
      'systemctl --failed': { code: 0, stdout: '', stderr: '' },
      'ss -ltnH': { code: 0, stdout: '', stderr: '' },
      journalctl: { code: 0, stdout: '', stderr: '' },
    }),
  })
  const tool = tools.get('svc_inspect')
  const value = await tool.execute({}, { agent: {}, callId: 'd3' })
  const rendered = tool.output.render({}, value)[0].text
  store.close()
  return value.status === 'fail'
    && value.delivery === null
    && warnings.length === 1
    && warnings[0].includes('P0 delivery failed')
    && !rendered.includes('delivered')
})

await check('expectedPorts turns a missing port into an immediate failure', async () => {
  const tools = new Map()
  const ctx = { tools: { register: (tool) => tools.set(tool.name, tool) } }
  const store = createInspectionStore(join(dir, 'ports.sqlite'))
  registerSvcTools(ctx, {
    inspections: store,
    expectedPorts: [8080],
    runner: runnerOf({
      df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n', stderr: '' },
      'systemctl --failed': { code: 0, stdout: '', stderr: '' },
      'ss -ltnH': { code: 0, stdout: 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:*\n', stderr: '' },
      journalctl: { code: 0, stdout: '', stderr: '' },
    }),
  })
  const value = await tools.get('svc_inspect').execute({}, { agent: {}, callId: 'p1' })
  store.close()
  const ports = value.items.find((entry) => entry.id === 'ports')
  return ports.status === 'fail'
    && ports.detail.includes('8080')
    && value.alert.level === 'immediate'
})

await check('quiet window suppresses the second immediate push', async () => {
  const tools = new Map()
  const infos = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    logger: { info: (message) => infos.push(message) },
  }
  const store = createInspectionStore(join(dir, 'quiet.sqlite'))
  const calls = []
  const notifier = withQuietWindow({
    transport: 'fake',
    async notify(level, message) {
      calls.push({ level, message })
      return { transport: 'fake', id: `msg-${calls.length}`, deliveredAt: '2026-11-06T10:00:00.000Z' }
    },
  }, { windowMs: 60_000 })
  registerSvcTools(ctx, {
    inspections: store,
    notifier,
    runner: runnerOf({
      df: { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 990 10 99% /\n', stderr: '' },
      'systemctl --failed': { code: 0, stdout: '', stderr: '' },
      'ss -ltnH': { code: 0, stdout: '', stderr: '' },
      journalctl: { code: 0, stdout: '', stderr: '' },
    }),
  })
  const tool = tools.get('svc_inspect')
  const first = await tool.execute({}, { agent: {}, callId: 'q1' })
  const second = await tool.execute({}, { agent: {}, callId: 'q2' })
  store.close()
  return calls.length === 1
    && first.delivery?.id === 'msg-1'
    && second.delivery === null
    && second.alert.level === 'immediate'
    && infos.some((line) => line.includes('suppressed by the quiet window'))
})

await check('quietWindowMs defaults, honours 0 and rejects junk', () => {
  return quietWindowMs({}) === 1_800_000
    && quietWindowMs({ DSH_WFXM_NOTIFY_QUIET_MINUTES: '5' }) === 300_000
    && quietWindowMs({ DSH_WFXM_NOTIFY_QUIET_MINUTES: '0' }) === 0
    && quietWindowMs({ DSH_WFXM_NOTIFY_QUIET_MINUTES: 'abc' }) === 1_800_000
    && quietWindowMs({ DSH_WFXM_NOTIFY_QUIET_MINUTES: '-1' }) === 1_800_000
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
