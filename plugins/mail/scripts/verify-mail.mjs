/**
 * `@dsh-wfxm/mail`（J1）：配置、参数校验、查询错误分类、工具注册与 Python 自测。
 *
 * 运行：node plugins/mail/scripts/verify-mail.mjs
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DEFAULT_CREDENTIALS_PATH,
  MAIL_TOOL_RISK,
  MailError,
  buildMailDigest,
  classifyMail,
  digestDue,
  isIsoDate,
  localDayMinutes,
  parseDigestEnv,
  readDigestState,
  readMailAccount,
  registerMailTools,
  renderDigest,
  searchMail,
  validateDigestArgs,
  validateReadArgs,
  validateSearchArgs,
  writeDigestState,
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

function rejects(fn, code) {
  try {
    fn()
    return false
  } catch (error) {
    return error instanceof MailError && (code === undefined || error.code === code)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-'))
const credentialsPath = join(dir, 'credentials.yaml')
writeFileSync(credentialsPath, 'refs:\n  mail/qq: super-secret\n')
const configPath = join(dir, 'config.json')
writeFileSync(configPath, JSON.stringify({
  account: { host: 'imap.qq.com', port: 993, secure: true, user: 'me@qq.com', secretRef: 'mail/qq' },
}))

await check('env account wins and defaults the port', () => {
  const result = readMailAccount({
    env: { DSH_WFXM_MAIL_HOST: 'imap.example.com', DSH_WFXM_MAIL_USER: 'u@example.com', DSH_WFXM_MAIL_PASSWORD: 'p' },
  })
  return result.ok && result.source === 'env' && result.account.port === 993 && result.account.password === 'p'
})

await check('file + secretRef resolves the password', () => {
  const result = readMailAccount({ configPath, credentialsPath, env: {} })
  return result.ok && result.source === 'file' && result.account.password === 'super-secret'
    && result.account.host === 'imap.qq.com'
})

await check('missing config is a readable config error', () => {
  const result = readMailAccount({ configPath: join(dir, 'missing.json'), env: {} })
  return !result.ok && result.code === 'config' && result.message.includes('未配置邮箱')
})

await check('missing secretRef target is a config error', () => {
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, JSON.stringify({ account: { host: 'h', user: 'u', secretRef: 'mail/none' } }))
  const result = readMailAccount({ configPath: bad, credentialsPath, env: {} })
  return !result.ok && result.code === 'config' && result.message.includes('not found')
})

await check('invalid json and missing fields are config errors', () => {
  const invalid = join(dir, 'invalid.json')
  writeFileSync(invalid, '{not json')
  const broken = readMailAccount({ configPath: invalid, env: {} })
  const empty = join(dir, 'empty.json')
  writeFileSync(empty, JSON.stringify({ account: { user: 'u', password: 'p' } }))
  const noHost = readMailAccount({ configPath: empty, env: {} })
  return !broken.ok && broken.code === 'config'
    && !noHost.ok && noHost.message.includes('account.host')
})

await check('search args validate dates and limits', () => {
  const ok = validateSearchArgs({ query: '账单', from: 'a@b.c', since: '2026-11-01', before: '2026-11-18', limit: 10 })
  return ok.limit === 10 && ok.since === '2026-11-01' && ok.query === '账单'
    && rejects(() => validateSearchArgs({ since: '2026-13-01' }))
    && rejects(() => validateSearchArgs({ since: '2026-02-30' }))
    && rejects(() => validateSearchArgs({ limit: 0 }))
    && rejects(() => validateSearchArgs({ limit: 51 }))
    && rejects(() => validateSearchArgs({ limit: 1.5 }))
    && rejects(() => validateSearchArgs({ from: 42 }))
})

await check('read args validate uid and maxChars', () => {
  const ok = validateReadArgs({ uid: 12, maxChars: 2000 })
  return ok.uid === 12 && ok.maxChars === 2000
    && rejects(() => validateReadArgs({ uid: 0 }))
    && rejects(() => validateReadArgs({ uid: -1 }))
    && validateReadArgs({ uid: '12' }).uid === 12
    && rejects(() => validateReadArgs({ uid: 1, maxChars: 20_001 }))
})

await check('iso date helper is strict', () => {
  return isIsoDate('2026-11-18') && !isIsoDate('2026-1-1') && !isIsoDate('18-11-2026')
})

// ---- 查询：用 node 充当"解释器"，脚本从 stdin 读 JSON -------------------------------
const fakeScript = join(dir, 'fake.mjs')
writeFileSync(fakeScript, `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(input)
  if (payload.request.query === 'auth') {
    console.log(JSON.stringify({ ok: false, code: 'auth', message: 'login failed' }))
    return
  }
  if (payload.request.query === 'garbage') {
    console.log('not json')
    return
  }
  if (payload.request.query === 'slow') {
    setTimeout(() => console.log(JSON.stringify({ ok: true, mailbox: 'INBOX', total: 0, scanned: 0, localFilter: false, messages: [] })), 2000)
    return
  }
  console.log(JSON.stringify({
    ok: true,
    mailbox: 'INBOX',
    total: Number(payload.request.limit ?? 1),
    scanned: 1,
    localFilter: false,
    messages: [{ uid: 7, date: 'Tue, 18 Nov 2026 10:00:00 +0800', from: 'a@b.c', to: 'me@qq.com', subject: '你好', sizeBytes: 10, seen: false }],
    echoPassword: payload.account.password,
  }))
})
`)

const account = { host: 'imap.qq.com', port: 993, secure: true, user: 'me@qq.com', password: 'secret-in-stdin' }
const queryOptions = { account, python: process.execPath, scriptPath: fakeScript, timeoutMs: 2000 }

await check('query passes the password through stdin and parses output', async () => {
  const result = await searchMail({ limit: 3 }, queryOptions)
  return result.total === 3 && result.messages[0].uid === 7 && result.messages[0].subject === '你好'
})

await check('auth errors stay classifiable', async () => {
  try {
    await searchMail({ query: 'auth' }, queryOptions)
    return false
  } catch (error) {
    return error instanceof MailError && error.code === 'auth' && error.message.includes('login failed')
  }
})

await check('non-JSON output is a parse error', async () => {
  try {
    await searchMail({ query: 'garbage' }, queryOptions)
    return false
  } catch (error) {
    return error instanceof MailError && error.code === 'parse'
  }
})

await check('timeouts are reported as timeout', async () => {
  try {
    await searchMail({ query: 'slow' }, { ...queryOptions, timeoutMs: 100 })
    return false
  } catch (error) {
    return error instanceof MailError && error.code === 'timeout'
  }
})

await check('a missing interpreter is unavailable', async () => {
  try {
    await searchMail({}, { ...queryOptions, python: join(dir, 'no-such-python') })
    return false
  } catch (error) {
    return error instanceof MailError && error.code === 'unavailable'
  }
})

// ---- 工具注册 -------------------------------------------------------------------
function fakeContext() {
  const captured = []
  return {
    tools: { register(tool) { captured.push(tool) } },
    logger: { info() {} },
    captured,
  }
}

await check('registers exactly three read-only tools', () => {
  const ctx = fakeContext()
  registerMailTools(ctx)
  const names = ctx.captured.map((tool) => tool.name).sort()
  return names.length === 3 && names.join(',') === 'mail_digest,mail_read,mail_search'
    && ctx.captured.every((tool) => String(tool.description).toLowerCase().includes('read-only'))
    && MAIL_TOOL_RISK.mail_search === 'R0' && MAIL_TOOL_RISK.mail_read === 'R0'
    && MAIL_TOOL_RISK.mail_digest === 'R0'
})

await check('tools surface a readable error when mail is not configured', async () => {
  const ctx = fakeContext()
  registerMailTools(ctx, { config: () => ({ ok: false, code: 'config', message: '未配置邮箱' }) })
  const tool = ctx.captured.find((item) => item.name === 'mail_search')
  try {
    await tool.execute({ limit: 1 })
    return false
  } catch (error) {
    return error instanceof MailError && error.code === 'config' && error.message.includes('未配置邮箱')
  }
})

await check('tools return structured data when configured', async () => {
  const ctx = fakeContext()
  registerMailTools(ctx, {
    config: () => ({ ok: true, source: 'env', account }),
    search: async () => ({ mailbox: 'INBOX', total: 1, scanned: 1, localFilter: false, messages: [] }),
    read: async () => ({ uid: 9, date: '', from: '', to: '', subject: 's', text: 'body', truncated: false, attachments: [] }),
  })
  const search = ctx.captured.find((item) => item.name === 'mail_search')
  const read = ctx.captured.find((item) => item.name === 'mail_read')
  const searched = await search.execute({ limit: 2 })
  const readResult = await read.execute({ uid: 9 })
  return searched.total === 1 && readResult.uid === 9 && readResult.text === 'body'
})

await check('mail credentials live beside the integration, not in dsh credential store', () => {
  return DEFAULT_CREDENTIALS_PATH.endsWith('/.dsh/integrations/dsh-mail/credentials.yaml')
    && !DEFAULT_CREDENTIALS_PATH.endsWith('/.dsh/.credentials.yaml')
})

await check('mail_digest groups metadata into reply/action/fyi', () => {
  const messages = [
    { uid: 4, date: 'Thu, 19 Nov 2026 09:30:00 +0800', from: 'no-reply@shop.com', to: 'me@163.com', subject: '请回复确认订阅', sizeBytes: 10, seen: true },
    { uid: 3, date: 'Thu, 19 Nov 2026 09:20:00 +0800', from: 'news@shop.com', to: 'me@163.com', subject: '本周促销', sizeBytes: 10, seen: false },
    { uid: 2, date: 'Thu, 19 Nov 2026 09:10:00 +0800', from: 'billing@vendor.com', to: 'me@163.com', subject: '十一月账单已出', sizeBytes: 10, seen: true },
    { uid: 1, date: 'Thu, 19 Nov 2026 09:00:00 +0800', from: 'Alice <alice@example.com>', to: 'me@163.com', subject: '这份合同需要你确认', sizeBytes: 10, seen: false },
  ]
  const result = buildMailDigest(
    { mailbox: 'INBOX', messages },
    { now: new Date('2026-11-19T02:00:00Z'), request: { hours: 24, limit: 20 } },
  )
  const ids = (group) => result.groups[group].map((item) => item.uid)
  return result.total === 4 && result.unread === 2 && result.truncated === false
    && ids('reply').join() === '1'
    && ids('action').join() === '2'
    && ids('fyi').join() === '4,3'
})

await check('mail_digest honors the window, unreadOnly and limit', () => {
  const messages = [
    { uid: 3, date: 'Thu, 19 Nov 2026 09:00:00 +0800', from: 'a@x.com', to: 'me@163.com', subject: '新邮件', sizeBytes: 10, seen: false },
    { uid: 2, date: 'Wed, 18 Nov 2026 11:00:00 +0800', from: 'b@x.com', to: 'me@163.com', subject: '旧邮件', sizeBytes: 10, seen: false },
    { uid: 1, date: 'Sat, 15 Nov 2026 09:00:00 +0800', from: 'c@x.com', to: 'me@163.com', subject: '更旧', sizeBytes: 10, seen: true },
  ]
  const windowed = buildMailDigest(
    { mailbox: 'INBOX', messages },
    { now: new Date('2026-11-19T02:00:00Z'), request: { hours: 24, limit: 20 } },
  )
  const unread = buildMailDigest(
    { mailbox: 'INBOX', messages },
    { now: new Date('2026-11-19T02:00:00Z'), request: { hours: 48, unreadOnly: true, limit: 20 } },
  )
  const capped = buildMailDigest(
    { mailbox: 'INBOX', messages },
    { now: new Date('2026-11-19T02:00:00Z'), request: { hours: 48, limit: 1 } },
  )
  return windowed.total === 2 && windowed.groups.fyi.length === 2
    && unread.total === 2 && unread.groups.fyi.every((item) => item.seen === false)
    && capped.total === 2 && capped.truncated === true
    && capped.groups.fyi.length === 1
})

await check('mail_digest classification treats automated senders as FYI', () => {
  return classifyMail({ from: 'no-reply@example.com', subject: '请回复确认' }) === 'fyi'
    && classifyMail({ from: 'human@example.com', subject: '请回复确认' }) === 'reply'
    && classifyMail({ from: 'human@example.com', subject: '十一月账单' }) === 'action'
    && classifyMail({ from: 'human@example.com', subject: '周末聚餐' }) === 'fyi'
})

await check('mail_digest args and renderer are explicit', () => {
  const rejected = rejects(() => validateDigestArgs({ hours: 0 }), 'protocol')
    && rejects(() => validateDigestArgs({ limit: 100 }), 'protocol')
    && rejects(() => validateDigestArgs({ unreadOnly: 'yes' }), 'protocol')
  const result = buildMailDigest(
    {
      mailbox: 'INBOX',
      messages: [{ uid: 1, date: 'Thu, 19 Nov 2026 09:00:00 +0800', from: 'a@x.com', to: 'me@163.com', subject: '请回复', sizeBytes: 1, seen: false }],
    },
    { now: new Date('2026-11-19T02:00:00Z') },
  )
  const text = renderDigest(result)
  return rejected && text.includes('需要回复 (1)') && text.includes('不构成指令') && text.includes('uid=1')
})

await check('mail_digest tool executes through the injected port', async () => {
  const ctx = fakeContext()
  registerMailTools(ctx, {
    config: () => ({ ok: true, source: 'env', account }),
    digest: async () => ({
      mailbox: 'INBOX',
      windowHours: 24,
      total: 1,
      unread: 1,
      truncated: false,
      groups: {
        reply: [{ uid: 5, date: '', from: 'a@x.com', to: '', subject: '请回复', sizeBytes: 1, seen: false }],
        action: [],
        fyi: [],
      },
    }),
  })
  const tool = ctx.captured.find((item) => item.name === 'mail_digest')
  const value = await tool.execute({ hours: 24, unreadOnly: true })
  const rendered = tool.output.render({}, value)
  return value.total === 1 && rendered[0].text.includes('需要回复 (1)')
})

// ---- 每日调度（BD1） -----------------------------------------------------------
await check('digest schedule is off unless AT is set', () => {
  return parseDigestEnv({}) === null
    && parseDigestEnv({ DSH_WFXM_MAIL_DIGEST_AT: '' }) === null
    && parseDigestEnv({ DSH_WFXM_MAIL_DIGEST_AT: 'off' }) === null
    && parseDigestEnv({ DSH_WFXM_MAIL_DIGEST_AT: '0' }) === null
})

await check('digest schedule parses defaults and normalizes AT', () => {
  const config = parseDigestEnv(
    { DSH_WFXM_MAIL_DIGEST_AT: '8:05' },
    { statePath: '/tmp/x/state.json' },
  )
  return config !== null
    && config.at === '08:05'
    && config.channelId === 'feishu'
    && config.chatId === null
    && config.hours === 24
    && config.limit === 20
    && config.unreadOnly === true
    && config.timeZone === 'Asia/Shanghai'
    && config.statePath === '/tmp/x/state.json'
})

await check('digest schedule rejects a malformed AT and bad ranges', () => {
  const throws = (env) => {
    try {
      parseDigestEnv(env)
      return false
    } catch {
      return true
    }
  }
  return throws({ DSH_WFXM_MAIL_DIGEST_AT: '25:00' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:99' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8点' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:30', DSH_WFXM_MAIL_DIGEST_HOURS: '0' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:30', DSH_WFXM_MAIL_DIGEST_HOURS: '169' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:30', DSH_WFXM_MAIL_DIGEST_LIMIT: '51' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:30', DSH_WFXM_MAIL_DIGEST_LIMIT: '1.5' })
    && throws({ DSH_WFXM_MAIL_DIGEST_AT: '8:30', DSH_WFXM_MAIL_DIGEST_TZ: 'Mars/Base' })
})

await check('digest schedule honors explicit channel, chat and unread flag', () => {
  const config = parseDigestEnv({
    DSH_WFXM_MAIL_DIGEST_AT: '08:30',
    DSH_WFXM_MAIL_DIGEST_CHANNEL: 'wecom',
    DSH_WFXM_MAIL_DIGEST_CHAT_ID: 'oc_owner',
    DSH_WFXM_MAIL_DIGEST_UNREAD: 'false',
    DSH_WFXM_MAIL_DIGEST_HOURS: '48',
    DSH_WFXM_MAIL_DIGEST_LIMIT: '5',
    DSH_WFXM_MAIL_DIGEST_STATE: '/var/lib/x/state.json',
  })
  return config !== null
    && config.channelId === 'wecom'
    && config.chatId === 'oc_owner'
    && config.unreadOnly === false
    && config.hours === 48
    && config.limit === 5
    && config.statePath === '/var/lib/x/state.json'
})

await check('digest local clock uses the explicit timezone', () => {
  const now = new Date('2026-11-19T00:30:00.000Z')
  const shanghai = localDayMinutes(now, 'Asia/Shanghai')
  const utc = localDayMinutes(now, 'UTC')
  return shanghai.date === '2026-11-19' && shanghai.minutes === 8 * 60 + 30
    && utc.date === '2026-11-19' && utc.minutes === 30
})

await check('digest is due only after AT and once per local day', () => {
  const base = {
    at: '08:30',
    lastDate: null,
    timeZone: 'Asia/Shanghai',
  }
  return !digestDue({ ...base, now: new Date('2026-11-19T00:29:00.000Z') })
    && digestDue({ ...base, now: new Date('2026-11-19T00:30:00.000Z') })
    && digestDue({ ...base, now: new Date('2026-11-19T01:10:00.000Z') })
    && !digestDue({ ...base, lastDate: '2026-11-19', now: new Date('2026-11-19T01:10:00.000Z') })
    && digestDue({ ...base, lastDate: '2026-11-18', now: new Date('2026-11-19T01:10:00.000Z') })
})

await check('digest state survives missing/corrupt files and round-trips', () => {
  const statePath = join(dir, 'digest-state.json')
  const missing = readDigestState(statePath)
  writeFileSync(statePath, '{not json')
  const corrupt = readDigestState(statePath)
  writeDigestState(statePath, { lastDate: '2026-11-19', firedAt: '2026-11-19T00:30:00.000Z' })
  const written = readDigestState(statePath)
  return missing.lastDate === null
    && corrupt.lastDate === null
    && written.lastDate === '2026-11-19'
    && readDigestState(null).lastDate === null
})

// ---- Python 自测 ---------------------------------------------------------------
await check('python backend self-test passes', () => {
  const script = fileURLToPath(new URL('../scripts/mail-query.py', import.meta.url))
  const result = spawnSync('python3', [script], { input: '{"action":"self-test"}', encoding: 'utf8' })
  if (result.status !== 0) return false
  const parsed = JSON.parse(result.stdout)
  return parsed.ok === true && parsed.checks >= 8
})

// ---- profile 安装脚本 ----------------------------------------------------------
await check('install script is idempotent and links the package', async () => {
  const profileDir = join(dir, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))

  const run = () => spawnSync(process.execPath, [
    fileURLToPath(new URL('../../../scripts/install-mail-profile.mjs', import.meta.url)),
    '--profile-dir', profileDir,
  ], { encoding: 'utf8' })

  const first = run()
  const second = run()
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const firstJson = JSON.parse(first.stdout)
  const secondJson = JSON.parse(second.stdout)
  return first.status === 0 && second.status === 0
    && firstJson.changed === true && secondJson.changed === false
    && pkg.dependencies['@dsh-wfxm/mail'].startsWith('link:')
    && pkg.dsh.profile.bundles.includes('@dsh-wfxm/mail')
    && existsSync(join(profileDir, 'node_modules/@dsh-wfxm/mail'))
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
