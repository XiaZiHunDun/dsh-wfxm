import {
  DEFAULT_EXPERT_THRESHOLDS,
  DEFAULT_TRACE_HEALTH_THRESHOLDS,
  aggregateRouting,
  createSystemdAdapter,
  deriveSuggestions,
  evaluateExpertHealth,
  evaluateTraceHealth,
  formatRoutingWeekly,
  formatSuggestionDigest,
  formatSuggestions,
  formatSuggestionWeekly,
  readTraceHealthConfig,
  SvcOpsError,
} from '../lib/index.js'

const calls = []
const customRunner = {
  async run(argv) {
    calls.push(argv.join(' '))
    const key = argv.join(' ')
    if (key === 'systemctl --version') return { code: 0, stdout: 'systemd 252\n', stderr: '' }
    if (key.startsWith('systemctl list-units')) {
      return {
        code: 0,
        stdout: [
          '  dsh-wfxm-managed-api.service     loaded active running dsh-wfxm api',
          '  dsh-wfxm-managed-worker.service  loaded active running dsh-wfxm worker',
          '  dsh-wfxm-managed-old.service     loaded inactive dead  retired unit',
          '  nginx.service                    loaded active running web server',
          '  unrelated.service                loaded active running should be filtered',
        ].join('\n'),
        stderr: '',
      }
    }
    if (key === 'systemctl is-active dsh-wfxm-managed-api.service') {
      return { code: 0, stdout: 'active\n', stderr: '' }
    }
    if (key.startsWith('systemctl show dsh-wfxm-managed-api.service')) {
      return {
        code: 0,
        stdout: [
          'Id=dsh-wfxm-managed-api.service',
          'LoadState=loaded',
          'ActiveState=active',
          'SubState=running',
          'Description=dsh-wfxm api',
          'UnitFileState=enabled',
          'MainPID=1234',
          'ActiveEnterTimestamp=Wed 2026-11-04 10:00:00 CST',
          'NRestarts=0',
        ].join('\n'),
        stderr: '',
      }
    }
    if (key.startsWith('journalctl -u dsh-wfxm-managed-api.service')) {
      return { code: 0, stdout: '2026-11-04T10:00:00+0800 line one\n2026-11-04T10:00:01+0800 line two\n', stderr: '' }
    }
    if (key === 'systemctl start dsh-wfxm-managed-api.service') return { code: 0, stdout: '', stderr: '' }
    if (key === 'systemctl restart dsh-wfxm-managed-missing.service') {
      return { code: 5, stdout: '', stderr: 'Unit dsh-wfxm-managed-missing.service could not be found.' }
    }
    if (key === 'systemctl stop dsh-wfxm-managed-api.service') {
      return { code: 1, stdout: '', stderr: 'Access denied: interactive authentication required.' }
    }
    return { code: 0, stdout: '', stderr: '' }
  },
}

const adapter = createSystemdAdapter({ runner: customRunner })
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
async function rejects(name, fn, code) {
  try {
    await fn()
    fail++
    console.log(`FAIL  ${name} — expected ${code}, resolved`)
  } catch (error) {
    const ok = error instanceof SvcOpsError && error.code === code
    if (ok) {
      pass++
      console.log(`PASS  ${name}`)
    } else {
      fail++
      console.log(`FAIL  ${name} — ${error instanceof SvcOpsError ? error.code : error}`)
    }
  }
}

await check('runtime 标记为 systemd', () => Promise.resolve(adapter.runtime === 'systemd'))
await check('detect 识别可用 systemd', async () => (await adapter.detect()) === true)
await check('list 只返回托管前缀单元', async () => {
  const list = await adapter.list()
  return list.length === 3 && list.every((item) => item.unit.startsWith('dsh-wfxm-managed-'))
})
await check('list 解析 description', async () => {
  const list = await adapter.list()
  return list.find((item) => item.unit === 'dsh-wfxm-managed-api.service')?.description === 'dsh-wfxm api'
})
await check('status 解析 show 字段', async () => {
  const status = await adapter.status('dsh-wfxm-managed-api.service')
  return status.activeState === 'active'
    && status.subState === 'running'
    && status.mainPid === 1234
    && status.restarts === 0
    && status.unitFileState === 'enabled'
})
await check('logs 返回行且去掉空行', async () => {
  const logs = await adapter.logs('dsh-wfxm-managed-api.service', 50)
  return logs.lines.length === 2 && logs.lines[0].includes('line one')
})
await check('logs 行数上限 500', async () => {
  await adapter.logs('dsh-wfxm-managed-api.service', 9999)
  const call = calls.filter((item) => item.startsWith('journalctl')).at(-1)
  return call?.includes('-n 500') === true
})
await check('start 成功', async () => {
  const result = await adapter.start('dsh-wfxm-managed-api.service')
  return result.changed === true && result.action === 'start'
})
await rejects('非托管 unit 被拒绝', () => adapter.start('ssh.service'), 'not-allowed')
await rejects('实例 unit 被拒绝', () => adapter.stop('dsh-wfxm-managed-api@prod.service'), 'not-allowed')
await rejects('路径注入被拒绝', () => adapter.status('dsh-wfxm-managed-api.service/x'), 'not-allowed')
await rejects('不存在的 unit 映射 not-found', () => adapter.restart('dsh-wfxm-managed-missing.service'), 'not-found')
await rejects('权限失败映射 not-allowed', () => adapter.stop('dsh-wfxm-managed-api.service'), 'not-allowed')

const missing = createSystemdAdapter({
  runner: { async run() { return { code: 127, stdout: '', stderr: 'systemctl: not found' } } },
})
await check('没有 systemctl 时 detect 为 false', async () => (await missing.detect()) === false)

await check('写操作走 controlCommand，读操作仍走 systemctl', async () => {
  const seen = []
  const runner = {
    async run(argv) {
      seen.push(argv.join(' '))
      if (argv[0] === 'sudo') return { code: 0, stdout: '', stderr: '' }
      if (argv.join(' ').startsWith('systemctl show')) {
        return {
          code: 0,
          stdout: 'Id=dsh-wfxm-managed-api.service\nLoadState=loaded\nActiveState=active\n',
          stderr: '',
        }
      }
      return { code: 0, stdout: 'active\n', stderr: '' }
    },
  }
  const wrapped = createSystemdAdapter({
    runner,
    controlCommand: ['sudo', '-n', '/usr/local/sbin/dsh-wfxm-unit-control'],
  })
  await wrapped.restart('dsh-wfxm-managed-api.service')
  await wrapped.status('dsh-wfxm-managed-api.service')
  return seen.includes('sudo -n /usr/local/sbin/dsh-wfxm-unit-control restart dsh-wfxm-managed-api.service')
    && seen.some((key) => key.startsWith('systemctl show dsh-wfxm-managed-api.service'))
})

await check('CD suggestions: data integrity first, budget threshold, max 3', () => {
  const candidates = [
    { ruleId: 'disk-pressure', itemId: 'disk', target: 'h', status: 'warn', observed: '91%' },
    { ruleId: 'missing-ports', itemId: 'ports', target: 'h', status: 'fail', observed: '8080' },
  ]
  const list = deriveSuggestions({
    candidates,
    failures: { retryExhausted: 2, nonRetryable: 0, conflicts: 1 },
    reviewFacts: 4,
    budget: { tokens: 8_500, limit: 10_000 },
  })
  const text = formatSuggestions(list)
  return list.length === 3
    && list[0].action.includes('合并冲突')
    && list[1].action.includes('重试耗尽')
    && list[2].action.includes('token 已用 85%')
    && /^建议：\n1\. \[R2\]/.test(text)
    && /回复「做 #n」按正常审批流程发起，不会自动执行。/.test(text)
})

await check('CD suggestions: quiet state renders nothing; candidates respect max', () => {
  const empty = deriveSuggestions({
    candidates: [],
    failures: { retryExhausted: 0, nonRetryable: 1, conflicts: 0 },
    reviewFacts: 0,
    budget: null,
  })
  const many = deriveSuggestions({
    candidates: [1, 2, 3, 4].map((index) => ({
      ruleId: 'log-errors',
      itemId: `logs-${index}`,
      target: 'h',
      status: 'warn',
      observed: 'errors',
    })),
    failures: { retryExhausted: 0, nonRetryable: 0, conflicts: 0 },
    reviewFacts: 0,
    budget: null,
    max: 2,
  })
  return formatSuggestions(empty) === null && many.length === 2
})

await check('P7-3 digest: entries carry stable ids while ordinals stay reply-friendly', () => {
  const text = formatSuggestionDigest([
    { id: 'sug_0123456789', ordinal: 1, action: '排查重试耗尽', evidence: '近 7 天重试耗尽 2 个', risk: 'R1' },
    { id: 'sug_abcdef0123', ordinal: 2, action: '处理合并冲突', evidence: 'merge_state=conflict', risk: 'R2' },
  ])
  return /1\. \[R1\] 排查重试耗尽.* · 做 #sug_0123456789/.test(text)
    && /2\. \[R2\] 处理合并冲突.* · 做 #sug_abcdef0123/.test(text)
    && /做 #1」或「做 #sug_xxxxxxxx/.test(text)
    && formatSuggestionDigest([]) === null
})

await check('P7-6 trace: 阈值越线生成建议，样本不足保持安静', () => {
  const hot = deriveSuggestions({
    candidates: [],
    failures: { retryExhausted: 0, nonRetryable: 0, conflicts: 0 },
    reviewFacts: 0,
    budget: null,
    trace: {
      health: { attempts: 12, failedAttempts: 6, p95Ms: 420_000 },
      thresholds: { failRate: 0.3, p95Ms: 300_000, minAttempts: 10 },
    },
  })
  const cold = deriveSuggestions({
    candidates: [],
    failures: { retryExhausted: 0, nonRetryable: 0, conflicts: 0 },
    reviewFacts: 0,
    budget: null,
    trace: {
      health: { attempts: 4, failedAttempts: 4, p95Ms: 900_000 },
      thresholds: { failRate: 0.3, p95Ms: 300_000, minAttempts: 10 },
    },
  })
  return hot.length === 2
    && hot[0].action.includes('失败率')
    && hot[1].action.includes('p95')
    && /失败 6\/12（50%）/.test(hot[0].evidence)
    && /p95 7m0s/.test(hot[1].evidence)
    && formatSuggestions(cold) === null
})

await check('P7-6 trace: 关闭开关后只报另一条', () => {
  const onlyP95 = evaluateTraceHealth(
    { attempts: 20, failedAttempts: 0, p95Ms: 300_000 },
    { failRate: 0, p95Ms: 300_000, minAttempts: 10 },
  )
  const noRules = evaluateTraceHealth(
    { attempts: 20, failedAttempts: 20, p95Ms: 900_000 },
    { failRate: 0, p95Ms: 0, minAttempts: 10 },
  )
  return onlyP95.length === 1 && onlyP95[0].kind === 'p95' && noRules.length === 0
})

await check('P7-6 trace: env 配置与默认值', () => {
  const defaults = readTraceHealthConfig({})
  const custom = readTraceHealthConfig({
    DSH_WFXM_TRACE_FAIL_RATE_PCT: '50',
    DSH_WFXM_TRACE_P95_MS: '60000',
    DSH_WFXM_TRACE_MIN_ATTEMPTS: '3',
  })
  const bad = readTraceHealthConfig({ DSH_WFXM_TRACE_FAIL_RATE_PCT: 'x' })
  return defaults.thresholds.failRate === DEFAULT_TRACE_HEALTH_THRESHOLDS.failRate
    && defaults.thresholds.p95Ms === DEFAULT_TRACE_HEALTH_THRESHOLDS.p95Ms
    && defaults.thresholds.minAttempts === DEFAULT_TRACE_HEALTH_THRESHOLDS.minAttempts
    && defaults.warnings.length === 0
    && custom.thresholds.failRate === 0.5
    && custom.thresholds.p95Ms === 60_000
    && custom.thresholds.minAttempts === 3
    && bad.warnings.length === 1
    && bad.thresholds.failRate === DEFAULT_TRACE_HEALTH_THRESHOLDS.failRate
})

await check('G8 routing: 窗口内聚合路由、项目命中与专家成功率', () => {
  const decisions = [
    { action: 'answer', targetTaskId: null, projectId: 'p1', projectMatchedBy: 'explicit', createdAt: '2026-11-20T10:00:00.000Z' },
    { action: 'attach', targetTaskId: 't1', projectId: 'p1', projectMatchedBy: 'sticky', createdAt: '2026-11-21T10:00:00.000Z' },
    { action: 'attach', targetTaskId: 't2', projectId: null, projectMatchedBy: null, createdAt: '2026-11-22T10:00:00.000Z' },
    { action: 'ask', targetTaskId: null, projectId: null, projectMatchedBy: null, createdAt: '2026-11-23T10:00:00.000Z' },
    { action: 'attach', targetTaskId: 't-out', projectId: null, projectMatchedBy: null, createdAt: '2026-10-01T10:00:00.000Z' },
  ]
  const tasks = [
    { id: 't1', expert: 'builder', status: 'succeeded' },
    { id: 't2', expert: 'builder', status: 'failed' },
    { id: 't-out', expert: 'builder', status: 'failed' },
  ]
  const stats = aggregateRouting({
    decisions,
    tasks,
    from: new Date('2026-11-19T00:00:00Z'),
    to: new Date('2026-11-26T00:00:00Z'),
  })
  const text = formatRoutingWeekly(stats)
  return stats.decisions === 4
    && stats.actions[0].action === 'attach' && stats.actions[0].count === 2
    && stats.projects.length === 2
    && stats.experts.length === 1
    && stats.experts[0].finished === 2
    && stats.experts[0].failed === 1
    && text.includes('路由（近 7 天）：决策 4')
    && text.includes('项目命中：')
    && text.includes('专家：builder 2 · 成功 1/2（50%）')
    && aggregateRouting({ decisions: decisions.slice(4), tasks, from: new Date('2026-11-19T00:00:00Z'), to: new Date('2026-11-26T00:00:00Z') }) === null
})

await check('G8 routing: 失败率越线才生成建议（样本不足保持安静）', () => {
  const hot = [{ expert: 'builder', routed: 8, finished: 8, succeeded: 4, failed: 4 }]
  const cold = [{ expert: 'builder', routed: 4, finished: 4, succeeded: 1, failed: 3 }]
  const breaches = evaluateExpertHealth(hot)
  const list = deriveSuggestions({
    candidates: [],
    failures: { retryExhausted: 0, nonRetryable: 0, conflicts: 0 },
    reviewFacts: 0,
    budget: null,
    routing: { experts: hot },
  })
  return DEFAULT_EXPERT_THRESHOLDS.minFinished === 5
    && breaches.length === 1
    && breaches[0].reason.includes('失败 4/8（50%）')
    && evaluateExpertHealth(cold).length === 0
    && list.length === 1
    && list[0].risk === 'R1'
    && list[0].action.includes('专家 builder')
    && list[0].evidence.includes('失败 4/8（50%）')
})

await check('§六 第 3 条：周报建议采纳率（无建议时省略）', () => {
  const text = formatSuggestionWeekly({ total: 4, accepted: 2, ignored: 1, pending: 1 })
  return text === '建议（近 7 天）：4 条 · 采纳 2 · 忽略 1 · 待定 1（采纳率 50%）'
    && formatSuggestionWeekly({ total: 0, accepted: 0, ignored: 0, pending: 0 }) === null
    && formatSuggestionWeekly(null) === null
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
