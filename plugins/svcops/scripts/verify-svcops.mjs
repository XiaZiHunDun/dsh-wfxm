import { createSystemdAdapter, deriveSuggestions, formatSuggestions, SvcOpsError } from '../lib/index.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
