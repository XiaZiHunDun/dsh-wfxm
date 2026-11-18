/**
 * Health alert verification (docs/16 §12.29): the notifier must fire only when
 * the service is down, stay quiet inside the cooldown, and speak up again when
 * the failure state changes. All dependencies are injected, so this suite never
 * touches systemd, Feishu, or the production DB.
 *
 *   node scripts/verify-health-alert.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildText,
  readChatId,
  readState,
  runHealthAlert,
  shouldSend,
} from './health-alert.mjs'

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    const note = await fn()
    passed += 1
    console.log(`PASS ${name}${note === undefined ? '' : ` — ${note}`}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-health-'))

await check('告警正文包含状态、主机与排查命令', () => {
  const text = buildText('failed', 'host-a', new Date('2026-11-18T00:00:00Z'))
  assert(text.includes('当前状态：failed'), text)
  assert(text.includes('host-a'), text)
  assert(text.includes('journalctl -u dsh-wfxm'), text)
  return 'failed'
})

await check('冷却窗口：无记录立即发，30 分钟内不发，过窗再发', () => {
  const now = 1_800_000_000_000
  assert.equal(shouldSend(null, now), true)
  assert.equal(shouldSend({ state: 'failed', sentAtMs: now - 5 * 60_000 }, now), false)
  assert.equal(shouldSend({ state: 'failed', sentAtMs: now - 31 * 60_000 }, now), true)
  return 'ok'
})

await check('健康时不发送', async () => {
  const sent = []
  const result = await runHealthAlert({
    checkService: () => 'active',
    statePath: join(stateDir, 'healthy.state'),
    loadChatId: () => 'oc_1',
    send: async (text, chatId) => sent.push({ text, chatId }),
  })
  assert.equal(result.status, 'healthy')
  assert.equal(sent.length, 0)
  return 'skipped'
})

await check('异常时发送一次并落状态', async () => {
  const sent = []
  const statePath = join(stateDir, 'failed.state')
  const result = await runHealthAlert({
    checkService: () => 'failed',
    statePath,
    loadChatId: () => 'oc_1',
    send: async (text, chatId) => sent.push({ text, chatId }),
  })
  assert.equal(result.status, 'sent')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'oc_1')
  assert(readState(statePath).state === 'failed', 'state not persisted')
  return 'sent'
})

await check('同一状态在冷却窗口内不重复发送', async () => {
  const sent = []
  const statePath = join(stateDir, 'cooldown.state')
  const deps = {
    checkService: () => 'failed',
    statePath,
    loadChatId: () => 'oc_1',
    send: async (text) => sent.push(text),
  }
  await runHealthAlert({ ...deps, nowMs: 1_800_000_000_000 })
  const second = await runHealthAlert({ ...deps, nowMs: 1_800_000_000_000 + 60_000 })
  assert.equal(second.status, 'cooldown')
  assert.equal(sent.length, 1)
  return 'cooldown'
})

await check('失败状态变化时即使处于窗口内也会再发', async () => {
  const sent = []
  const statePath = join(stateDir, 'changed.state')
  await runHealthAlert({
    checkService: () => 'failed',
    statePath,
    loadChatId: () => 'oc_1',
    send: async (text) => sent.push(text),
    nowMs: 1_800_000_000_000,
  })
  const second = await runHealthAlert({
    checkService: () => 'inactive',
    statePath,
    loadChatId: () => 'oc_1',
    send: async (text) => sent.push(text),
    nowMs: 1_800_000_000_000 + 60_000,
  })
  assert.equal(second.status, 'sent')
  assert.equal(sent.length, 2)
  return 'state-change'
})

await check('聊天 id 从 threads 表读取', async () => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const dbPath = join(stateDir, 'threads.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads (chat_id TEXT, channel_id TEXT)')
  db.exec("INSERT INTO threads VALUES ('oc_last', 'feishu')")
  db.close()
  assert.equal(readChatId(dbPath), 'oc_last')
  assert.equal(readChatId(join(stateDir, 'missing.sqlite')), null)
  return 'oc_last'
})

rmSync(stateDir, { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
