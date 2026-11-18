/**
 * `@dsh-wfxm/reminder`（J5）：表、API 与时间计算。
 *
 * 运行：node plugins/reminder/scripts/verify-reminder.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReminderError,
  createReminderStore,
  formatReminderDue,
  nextDueAt,
  repeatSuffix,
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

function throwsReminder(fn) {
  try {
    fn()
    return false
  } catch (error) {
    return error instanceof ReminderError
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-reminder-'))
const dbPath = join(dir, 'reminders.sqlite')
const base = new Date('2026-11-18T03:00:00.000Z') // 上海 11:00
const at = (iso) => new Date(iso)

const store = createReminderStore(dbPath)

await check('create returns a pending reminder', async () => {
  const item = store.create({
    threadId: 'thread-1',
    text: '交水电费',
    dueAt: '2026-11-19T01:00:00.000Z',
    sourceMsgId: 'om_1',
    now: base,
  })
  return item.status === 'pending'
    && item.repeat === 'none'
    && item.threadId === 'thread-1'
    && store.get(item.id)?.text === '交水电费'
})

await check('reopening the same database is idempotent', async () => {
  const again = createReminderStore(dbPath)
  const rows = again.listPending('thread-1')
  again.close()
  return rows.length === 1
})

await check('listPending sorts by due time', async () => {
  store.create({ threadId: 'thread-1', text: '晚一点', dueAt: '2026-11-20T01:00:00.000Z', now: base })
  store.create({ threadId: 'thread-1', text: '早一点', dueAt: '2026-11-18T04:00:00.000Z', now: base })
  const texts = store.listPending('thread-1').map((item) => item.text)
  return texts[0] === '早一点' && texts[1] === '交水电费' && texts[2] === '晚一点'
})

await check('listPending is scoped to one thread', () => {
  store.create({ threadId: 'thread-2', text: '别的线程', dueAt: '2026-11-22T04:00:00.000Z', now: base })
  return store.listPending('thread-2').length === 1 && store.listPending('thread-1').length === 3
})

await check('listDue only returns due pending rows', () => {
  const due = store.listDue(at('2026-11-18T04:30:00.000Z'))
  return due.length === 1 && due[0].text === '早一点'
})

await check('invalid inputs are rejected', () => {
  return throwsReminder(() => store.create({ threadId: 't', text: '  ', dueAt: base }))
    && throwsReminder(() => store.create({ threadId: '', text: 'x', dueAt: base }))
    && throwsReminder(() => store.create({ threadId: 't', text: 'x', dueAt: 'not-a-date' }))
    && throwsReminder(() => store.create({ threadId: 't', text: 'x', dueAt: base, repeat: 'monthly' }))
    && throwsReminder(() => store.create({ threadId: 't', text: 'x'.repeat(201), dueAt: base }))
})

await check('one-off reminder is done after firing and cannot fire twice', () => {
  const item = store.listDue(at('2026-11-18T04:30:00.000Z'))[0]
  const fired = store.markFired(item.id, { now: at('2026-11-18T04:30:00.000Z') })
  return fired?.status === 'done'
    && fired.firedAt === '2026-11-18T04:30:00.000Z'
    && store.markFired(item.id, { now: at('2026-11-18T04:31:00.000Z') }) === null
    && store.listDue(at('2026-11-19T00:00:00.000Z')).every((row) => row.id !== item.id)
})

await check('daily reminder advances to the next future slot', () => {
  const item = store.create({
    threadId: 'thread-1',
    text: '吃药',
    dueAt: '2026-11-18T01:00:00.000Z',
    repeat: 'daily',
    now: base,
  })
  const next = nextDueAt(item.dueAt, 'daily', at('2026-11-18T03:00:00.000Z'))
  const fired = store.markFired(item.id, { nextDueAt: next, now: base })
  return fired?.status === 'pending' && fired.dueAt === '2026-11-19T01:00:00.000Z'
})

await check('missed cycles jump once instead of replaying', () => {
  const due = '2026-11-10T01:00:00.000Z'
  const next = nextDueAt(due, 'daily', at('2026-11-18T03:00:00.000Z'))
  return next === '2026-11-19T01:00:00.000Z'
})

await check('weekly reminder advances by seven days', () => {
  const next = nextDueAt('2026-11-16T01:00:00.000Z', 'weekly', at('2026-11-18T03:00:00.000Z'))
  return next === '2026-11-23T01:00:00.000Z'
})

await check('one-off has no next due time', () => {
  return nextDueAt('2026-11-18T01:00:00.000Z', 'none', base) === null
})

await check('cancel only affects pending rows', () => {
  const item = store.create({ threadId: 'thread-1', text: '可以取消', dueAt: '2026-11-21T01:00:00.000Z', now: base })
  const cancelled = store.cancel(item.id)
  return cancelled?.status === 'cancelled'
    && store.cancel(item.id) === null
    && store.listPending('thread-1').every((row) => row.id !== item.id)
})

await check('formatReminderDue uses Asia/Shanghai', () => {
  return formatReminderDue('2026-11-18T01:00:00.000Z', base) === '今天 09:00'
    && formatReminderDue('2026-11-19T01:00:00.000Z', base) === '明天 09:00'
    && formatReminderDue('2026-11-25T01:00:00.000Z', base) === '11-25 09:00'
    && formatReminderDue('2027-01-02T01:00:00.000Z', base) === '2027-01-02 09:00'
    && formatReminderDue('not-a-date', base) === 'not-a-date'
})

await check('repeat suffix is explicit', () => {
  return repeatSuffix('none') === '' && repeatSuffix('daily') === '（每天）' && repeatSuffix('weekly') === '（每周）'
})

store.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
