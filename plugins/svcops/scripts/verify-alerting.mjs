import { gradeInspection } from '../lib/index.js'

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

const item = (id, label, status, value, extra = {}) => ({
  id,
  label,
  status,
  value,
  threshold: 'test',
  ...extra,
})

const report = (...items) => ({ checklistId: 'default-min-safe', status: 'ok', items })

await check('fail -> immediate with item reason', () => {
  const decision = gradeInspection(report(item('disk', '根分区使用率', 'fail', '95%')))
  return decision.level === 'immediate'
    && decision.reasons.length === 1
    && decision.reasons[0] === '根分区使用率: 95%'
})

await check('any fail wins over warns and keeps checklist order', () => {
  const decision = gradeInspection(report(
    item('disk', '根分区使用率', 'warn', '86%'),
    item('units', '失败 unit', 'fail', '2', { detail: 'a.service, b.service' }),
    item('load', '1 分钟负载/核', 'fail', '4'),
    item('logs', '错误日志/60min', 'warn', '30'),
  ))
  return decision.level === 'immediate'
    && decision.reasons.join('|') === '失败 unit: 2（a.service, b.service）|1 分钟负载/核: 4'
})

await check('warn only -> digest', () => {
  const decision = gradeInspection(report(
    item('disk', '根分区使用率', 'warn', '86%'),
    item('memory', '可用内存', 'ok', '60%'),
  ))
  return decision.level === 'digest'
    && decision.reasons.length === 1
    && decision.reasons[0] === '根分区使用率: 86%'
})

await check('all ok -> silent with no reasons', () => {
  const decision = gradeInspection(report(
    item('disk', '根分区使用率', 'ok', '40%'),
    item('ports', '监听端口', 'ok', '2 个监听'),
  ))
  return decision.level === 'silent' && decision.reasons.length === 0
})

await check('all skipped -> silent, skipped is not an anomaly', () => {
  const decision = gradeInspection(report(
    item('disk', '根分区使用率', 'skipped', '不可读'),
    item('logs', '错误日志/60min', 'skipped', 'journal 不可读'),
  ))
  return decision.level === 'silent' && decision.reasons.length === 0
})

await check('skipped alongside warn stays digest', () => {
  const decision = gradeInspection(report(
    item('disk', '根分区使用率', 'skipped', '不可读'),
    item('memory', '可用内存', 'warn', '12%'),
  ))
  return decision.level === 'digest' && decision.reasons.length === 1
})

await check('detail is carried into the reason', () => {
  const decision = gradeInspection(report(
    item('ports', '监听端口', 'fail', '24 个监听', { detail: '缺失 8080' }),
  ))
  return decision.level === 'immediate'
    && decision.reasons[0] === '监听端口: 24 个监听（缺失 8080）'
})

await check('empty report -> silent', () => {
  const decision = gradeInspection(report())
  return decision.level === 'silent' && decision.reasons.length === 0
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
