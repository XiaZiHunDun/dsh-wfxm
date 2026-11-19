/**
 * Risk escalation policy (tasks/risk.ts): the model never raises risk, this
 * deterministic layer may, and only when it can attach a template assertion.
 */

import assert from 'node:assert/strict'

const { isMailArchiveIntent, managedUnitFor, planTaskRisk } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    const ok = fn()
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

check('「重启 demo 服务」升到 R3，并带 unit_restarted + service_active 两条模板断言', () => {
  const plan = planTaskRisk('重启 demo 服务', 'R1')
  return plan.risk === 'R3'
    && plan.reasons[0] === 'svc-start:dsh-wfxm-managed-demo.service'
    && plan.assertions.length === 2
    && plan.assertions[0].kind === 'unit_restarted'
    && plan.assertions[0].spec.unit === 'dsh-wfxm-managed-demo.service'
    && plan.assertions[1].kind === 'service_active'
    && plan.assertions[1].spec.unit === 'dsh-wfxm-managed-demo.service'
})

check('显式托管 unit 原样使用', () => {
  const plan = planTaskRisk('请重启 dsh-wfxm-managed-api.service', 'R1')
  assert.equal(plan.risk, 'R3')
  const kinds = plan.assertions.map((item) => item.kind)
  assert.deepEqual(kinds, ['unit_restarted', 'service_active'])
  for (const item of plan.assertions) {
    assert.equal(item.spec.unit, 'dsh-wfxm-managed-api.service')
  }
  return true
})

check('「启动」同样升 R3（start 与 restart 都有 unit_restarted + service_active 判据）', () => {
  const plan = planTaskRisk('启动 api service', 'R1')
  return plan.risk === 'R3'
    && plan.assertions.length === 2
    && plan.assertions[0].kind === 'unit_restarted'
    && plan.assertions[1].kind === 'service_active'
    && plan.assertions.every((item) => item.spec.unit === 'dsh-wfxm-managed-api.service')
})

check('「帮我重启一下 demo 服务」容忍口语插入', () => {
  return planTaskRisk('帮我重启一下 demo 服务', 'R1').risk === 'R3'
})

check('只读问句不升级：「重启后的服务状态怎么样」', () => {
  const plan = planTaskRisk('重启后的服务状态怎么样', 'R1')
  return plan.risk === 'R1' && plan.assertions.length === 0 && plan.reasons.length === 0
})

check('「看看 demo 服务状态」不升级', () => {
  return planTaskRisk('看看 demo 服务状态', 'R1').risk === 'R1'
})

check('停止不升级：无 service_inactive 判据，不做无判据的 R3', () => {
  return planTaskRisk('停止 demo 服务', 'R1').risk === 'R1'
})

check('容器不升级：service_active 只验证 systemd unit', () => {
  return planTaskRisk('重启 demo 容器', 'R1').risk === 'R1'
})

check('未写 .service 且没有「服务」名词：保守不升级', () => {
  return planTaskRisk('重启 dsh-wfxm-managed-api', 'R1').risk === 'R1'
})

check('基线已是 R2/R3 时只透传，不重复加断言', () => {
  const r2 = planTaskRisk('重启 demo 服务', 'R2')
  const r3 = planTaskRisk('重启 demo 服务', 'R3')
  return r2.risk === 'R2' && r2.assertions.length === 0
    && r3.risk === 'R3' && r3.assertions.length === 0
})

check('规则层只升不降：R0 的真实服务操作也会升到 R3', () => {
  return planTaskRisk('重启 demo 服务', 'R0').risk === 'R3'
})

check('「把这两封邮件归档」升 R2，并带 mail_archived（folder 省略=适配器默认）', () => {
  const plan = planTaskRisk('把这两封邮件归档一下', 'R1')
  assert.equal(plan.risk, 'R2')
  assert.deepEqual(plan.reasons, ['mail-archive'])
  assert.equal(plan.assertions.length, 1)
  assert.equal(plan.assertions[0].kind, 'mail_archived')
  assert.equal(plan.assertions[0].spec.minCount, 1)
  assert.equal(plan.assertions[0].spec.folder, undefined)
  return true
})

check('「归档 uid 1411137890」也识别为归档操作', () => {
  return planTaskRisk('归档 uid 1411137890', 'R1').risk === 'R2'
})

check('只读句式不升级：查看归档邮件 / 归档邮件里有什么 / 归档夹', () => {
  for (const text of ['查看归档邮件', '归档邮件里有什么', '归档夹里还有几封', '看看归档邮件']) {
    assert.equal(planTaskRisk(text, 'R1').risk, 'R1', text)
    assert.equal(isMailArchiveIntent(text), false, text)
  }
  return true
})

check('规则叠加：归档 + 写绝对路径同时保留两条断言', () => {
  const plan = planTaskRisk('把邮件归档，并把结果写入 /var/lib/dsh-wfxm/workspace/report.txt', 'R1')
  assert.equal(plan.risk, 'R2')
  assert.deepEqual(plan.reasons.sort(), ['file-write:/var/lib/dsh-wfxm/workspace/report.txt', 'mail-archive'])
  const kinds = plan.assertions.map((item) => item.kind).sort()
  assert.deepEqual(kinds, ['file_exists', 'mail_archived'])
  return true
})

check('managedUnitFor 只认托管前缀', () => {
  assert.equal(managedUnitFor('重启 dsh-wfxm-managed-api.service'), 'dsh-wfxm-managed-api.service')
  return managedUnitFor('重启 nginx 服务') === 'dsh-wfxm-managed-nginx.service'
})

console.log(`\nrisk: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
