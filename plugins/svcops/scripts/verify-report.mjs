import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInspectionStore,
  registerSvcTools,
  summarize,
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

const item = (status, value, detail) => ({
  id: `ix-${status}-${value}`,
  label: '根分区使用率',
  status,
  value,
  threshold: 'test',
  ...detail === undefined ? {} : { detail },
})

const record = (ranAt, status, items) => ({
  id: `id-${ranAt}`,
  checklistId: 'default-min-safe',
  target: 'host-a',
  status,
  items,
  ranAt,
})

const NOW = new Date('2026-11-06T12:00:00.000Z')

await check('window filter drops records older than N hours', () => {
  const digest = summarize([
    record('2026-11-06T11:00:00.000Z', 'ok', [item('ok', '40%')]),
    record('2026-11-04T12:00:00.000Z', 'fail', [item('fail', '99%')]),
  ], { hours: 24, now: NOW })
  return digest.runs === 1 && digest.byStatus.ok === 1 && digest.byStatus.fail === 0
})

await check('counts by status and alert level', () => {
  const digest = summarize([
    record('2026-11-06T11:00:00.000Z', 'ok', [item('ok', '40%')]),
    record('2026-11-06T10:00:00.000Z', 'warn', [item('warn', '86%')]),
    record('2026-11-06T09:00:00.000Z', 'fail', [item('fail', '95%')]),
    record('2026-11-06T08:00:00.000Z', 'skipped', [item('skipped', '不可读')]),
  ], { hours: 24, now: NOW })
  return digest.runs === 4
    && digest.byStatus.ok === 1 && digest.byStatus.warn === 1
    && digest.byStatus.fail === 1 && digest.byStatus.skipped === 1
    && digest.byAlert.silent === 2 && digest.byAlert.digest === 1 && digest.byAlert.immediate === 1
})

await check('latest is the newest record with its graded level', () => {
  const digest = summarize([
    record('2026-11-06T09:00:00.000Z', 'fail', [item('fail', '95%')]),
    record('2026-11-06T11:00:00.000Z', 'warn', [item('warn', '86%')]),
  ], { hours: 24, now: NOW })
  return digest.latest?.ranAt === '2026-11-06T11:00:00.000Z'
    && digest.latest.level === 'digest'
    && digest.latest.target === 'host-a'
})

await check('findings are newest first, de-duplicated and capped', () => {
  const digest = summarize([
    record('2026-11-06T09:00:00.000Z', 'fail', [item('fail', '95%')]),
    record('2026-11-06T10:00:00.000Z', 'fail', [item('fail', '95%'), item('fail', '2', 'a.service')]),
    record('2026-11-06T11:00:00.000Z', 'fail', [item('fail', '99%')]),
  ], { hours: 24, now: NOW, maxFindings: 2 })
  return digest.findings.length === 2
    && digest.findings[0] === '根分区使用率: 99%'
    && digest.findings[1] === '根分区使用率: 95%'
})

await check('empty window -> zero counts and null latest', () => {
  const digest = summarize([], { hours: 24, now: NOW })
  return digest.runs === 0
    && digest.latest === null
    && digest.findings.length === 0
    && digest.from === '2026-11-05T12:00:00.000Z'
    && digest.to === '2026-11-06T12:00:00.000Z'
})

const dir = mkdtempSync(join(tmpdir(), 'svcops-report-'))
const store = createInspectionStore(join(dir, 'ops.sqlite'))

await check('store.listSince returns rows inside the window, oldest first', () => {
  const first = store.save({ checklistId: 'default-min-safe', target: 'host-a', status: 'ok', items: [item('ok', '40%')] })
  const second = store.save({ checklistId: 'default-min-safe', target: 'host-a', status: 'warn', items: [item('warn', '86%')] })
  const all = store.listSince('2000-01-01T00:00:00.000Z')
  const future = store.listSince(new Date(Date.now() + 3_600_000).toISOString())
  return all.length === 2
    && all[0].id === first.id
    && all[1].id === second.id
    && future.length === 0
})

const tools = new Map()
registerSvcTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, { inspections: store })

await check('svc_report summarizes stored inspections', async () => {
  const value = await tools.get('svc_report').execute({ hours: 24 }, { agent: {}, callId: 'r1' })
  return value.runs === 2
    && value.byStatus.ok === 1
    && value.byStatus.warn === 1
    && value.byAlert.silent === 1
    && value.byAlert.digest === 1
    && value.latest.status === 'warn'
    && value.from < value.to
})

await check('svc_report clamps hours to 1-168', async () => {
  const high = await tools.get('svc_report').execute({ hours: 9999 }, { agent: {}, callId: 'r2' })
  const low = await tools.get('svc_report').execute({ hours: 0 }, { agent: {}, callId: 'r3' })
  return high.hours === 168 && low.hours === 1
})

await check('svc_report renders a digest text block', async () => {
  const tool = tools.get('svc_report')
  const value = await tool.execute({}, { agent: {}, callId: 'r4' })
  const blocks = tool.output.render({}, value)
  return blocks.length === 1
    && blocks[0].text.includes('inspection digest last 24h')
    && blocks[0].text.includes('status: ok 1 / warn 1')
    && blocks[0].text.includes('finding: 根分区使用率: 86%')
})

await check('svc_report fails closed without the store', async () => {
  const bare = new Map()
  registerSvcTools({ tools: { register: (tool) => bare.set(tool.name, tool) } }, { adapter: {
    runtime: 'systemd',
  } })
  let message = ''
  try {
    await bare.get('svc_report').execute({}, { agent: {}, callId: 'r5' })
  } catch (error) {
    message = String(error)
  }
  return message.includes('requires the inspections store')
})

store.close()

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
