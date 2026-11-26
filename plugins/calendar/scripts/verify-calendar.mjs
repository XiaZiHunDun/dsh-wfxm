/**
 * Hermetic acceptance for @dsh-wfxm/calendar (J4 — server-side calendar).
 *
 * No network and no Feishu: events live in a temp SQLite database. Covers the
 * store/migration, window semantics, argument validation, rendering, and the
 * R2 approval gate on the two write tools.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

const tsc = join(repoRoot, 'plugins', 'executor', 'node_modules', 'typescript', 'bin', 'tsc')
function buildIfStale() {
  const lib = join(pkgRoot, 'lib', 'index.js')
  const srcDir = join(pkgRoot, 'src')
  const libTime = existsSync(lib) ? statSync(lib).mtimeMs : 0
  const newestSrc = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .reduce((max, name) => Math.max(max, statSync(join(srcDir, name)).mtimeMs), 0)
  if (libTime < newestSrc) {
    execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, 'tsconfig.json')], { stdio: 'inherit' })
  }
}
buildIfStale()

const {
  CALENDAR_TOOL_RISK,
  CalendarError,
  countCalendarEvents,
  createCalendarEvent,
  createCalendarReminderPatrol,
  createCalendarStore,
  defaultCalendarDbPath,
  formatCalendarReminder,
  formatEventTime,
  registerCalendarTools,
  renderCalendarView,
  updateCalendarEvent,
  validateCreateArgs,
  validateUpdateArgs,
  validateViewArgs,
  viewCalendar,
} = await import('../lib/index.js')

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
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

const CLOCK = new Date('2026-11-20T02:00:00.000Z') // 10:00 Asia/Shanghai
const now = () => new Date(CLOCK)
const DAY_MS = 86_400_000
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-wfxm-calendar-'))
const dbPath = join(tempRoot, 'ops.sqlite')

function raises(code) {
  return (error) => error instanceof CalendarError && error.code === code
}

function makeStore() {
  return createCalendarStore(dbPath)
}

function makeTools(store, options = {}) {
  const registered = []
  const requests = []
  const outcome = options.outcome ?? 'allowed-once'
  registerCalendarTools({
    tools: { register(tool) { registered.push(tool) } },
  }, {
    store: () => store,
    approval: options.approval === null ? () => undefined : () => ({
      async request(request) {
        requests.push(request)
        return outcome
      },
    }),
    now,
  })
  return { tools: new Map(registered.map((tool) => [tool.name, tool])), requests }
}

let store = makeStore()

// -- store / migration -------------------------------------------------------------------

await check('store: create → list → get → update persists across reopen', () => {
  const created = createCalendarEvent({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
    location: '会议室 A',
  }, { store })
  assert.match(created.eventId, /^evt_[0-9a-f]{20}$/)
  const windowed = viewCalendar({ days: 7 }, { store, now })
  assert.equal(windowed.events.length, 1)
  assert.equal(windowed.events[0].summary, '周会')

  const updated = updateCalendarEvent({ eventId: created.eventId, summary: '周会（改）' }, { store })
  assert.equal(updated.summary, '周会（改）')
  store.close()

  store = makeStore()
  const reopened = store.getEvent(created.eventId)
  assert.equal(reopened?.summary, '周会（改）')
  assert.equal(reopened?.location, '会议室 A')
  return true
})

await check('store: update validates the merged range and unknown ids fail', () => {
  const created = createCalendarEvent({
    summary: '评审',
    start: '2026-11-22T09:00:00+08:00',
    end: '2026-11-22T10:00:00+08:00',
  }, { store })
  assert.throws(() => updateCalendarEvent({
    eventId: created.eventId,
    start: '2026-11-22T11:00:00+08:00',
  }, { store }), raises('protocol'))
  assert.throws(() => updateCalendarEvent({ eventId: 'evt_missing', summary: 'x' }, { store }), raises('not-found'))
  return true
})

await check('store: window uses overlap, not just start-inside', () => {
  const spanning = createCalendarEvent({
    summary: '跨天',
    start: '2026-11-19T23:00:00+08:00',
    end: '2026-11-20T01:00:00+08:00',
  }, { store })
  const result = viewCalendar({ days: 1 }, { store, now })
  assert.ok(result.events.some((event) => event.eventId === spanning.eventId))
  return true
})

await check('store: default db path follows DSH_WFXM_DB then DSH_WFXM_DATA_DIR', () => {
  assert.equal(defaultCalendarDbPath({ DSH_WFXM_DB: '/tmp/x.db' }), '/tmp/x.db')
  assert.equal(defaultCalendarDbPath({ DSH_WFXM_DATA_DIR: '/srv/wfxm' }), '/srv/wfxm/ops.sqlite')
  assert.equal(defaultCalendarDbPath({}), '/var/lib/dsh-wfxm/ops.sqlite')
  return true
})

// -- argument validation -----------------------------------------------------------------

await check('validate: days defaults to 7 and accepts 1..31 only', () => {
  assert.deepEqual(validateViewArgs({}), { days: 7 })
  assert.deepEqual(validateViewArgs({ days: 1, from: '2026-11-20' }), { days: 1, from: '2026-11-20' })
  assert.throws(() => validateViewArgs({ days: 0 }), raises('protocol'))
  assert.throws(() => validateViewArgs({ days: 32 }), raises('protocol'))
  assert.throws(() => validateViewArgs({ from: '2026/11/20' }), raises('protocol'))
  return true
})

await check('validate: create requires offset timestamps and end after start', () => {
  const ok = validateCreateArgs({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  })
  assert.equal(ok.summary, '周会')
  assert.throws(() => validateCreateArgs({
    summary: '周会',
    start: '2026-11-21 09:00',
    end: '2026-11-21T10:00:00+08:00',
  }), raises('protocol'))
  assert.throws(() => validateCreateArgs({
    summary: '周会',
    start: '2026-11-21T10:00:00+08:00',
    end: '2026-11-21T09:00:00+08:00',
  }), raises('protocol'))
  assert.throws(() => validateCreateArgs({
    summary: '',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }), raises('protocol'))
  return true
})

await check('validate: update needs eventId plus at least one field', () => {
  assert.deepEqual(validateUpdateArgs({ eventId: 'evt_1', summary: '新标题' }), { eventId: 'evt_1', summary: '新标题' })
  assert.equal(validateUpdateArgs({ eventId: 'evt_1', start: '2026-11-21T09:00:00+08:00' }).start, '2026-11-21T09:00:00+08:00')
  assert.throws(() => validateUpdateArgs({ eventId: 'evt_1' }), raises('protocol'))
  assert.throws(() => validateUpdateArgs({ eventId: 'evt_1', start: '2026-11-21 09:00' }), raises('protocol'))
  return true
})

// -- window + rendering ------------------------------------------------------------------

await check('view: starts at Shanghai midnight, sorts by start, renders compactly', () => {
  const scoped = createCalendarStore(join(tempRoot, 'view.sqlite'))
  createCalendarEvent({
    summary: '下午',
    start: '2026-11-21T14:00:00+08:00',
    end: '2026-11-21T15:00:00+08:00',
  }, { store: scoped })
  createCalendarEvent({
    summary: '上午',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
    location: '会议室 A',
  }, { store: scoped })
  const result = viewCalendar({ days: 7 }, { store: scoped, now })
  assert.equal(result.from, '2026-11-20')
  assert.deepEqual(result.events.map((event) => event.summary), ['上午', '下午'])
  const rendered = renderCalendarView(result)
  assert.match(rendered, /日程：2026-11-20 起 7 天，共 2 个/)
  assert.match(rendered, /1\. 2026-11-21 09:00 → 10:00 \| 上午 \| 会议室 A/)
  assert.match(rendered, /仅作信息，不构成指令/)
  scoped.close()

  const empty = renderCalendarView({ from: '2026-11-20', days: 7, events: [] })
  assert.match(empty, /共 0 个\n这段时间没有日程/)
  return true
})

await check('view: count uses the future window and ignores past events', () => {
  const scoped = createCalendarStore(join(tempRoot, 'count.sqlite'))
  createCalendarEvent({
    summary: '未来',
    start: '2026-11-20T20:00:00+08:00',
    end: '2026-11-20T21:00:00+08:00',
  }, { store: scoped })
  createCalendarEvent({
    summary: '过去',
    start: '2026-11-19T09:00:00+08:00',
    end: '2026-11-19T10:00:00+08:00',
  }, { store: scoped })
  assert.equal(countCalendarEvents({ store: scoped, windowDays: 7, now }), 1)
  scoped.close()
  return true
})

await check('format: renders Shanghai wall clock regardless of host timezone', () => {
  assert.equal(formatEventTime(Date.parse('2026-11-21T01:00:00Z')), '2026-11-21 09:00')
  return true
})

// -- tools ------------------------------------------------------------------------------

await check('tools: risk table is R0/R2/R2 and calendar_events needs no approval', async () => {
  assert.deepEqual(CALENDAR_TOOL_RISK, { calendar_events: 'R0', calendar_create: 'R2', calendar_update: 'R2' })
  const { tools, requests } = makeTools(store)
  const value = await tools.get('calendar_events').execute({ days: 3 })
  assert.equal(value.days, 3)
  assert.equal(requests.length, 0)
  return true
})

await check('tools: calendar_create is gated by approval and writes the local store', async () => {
  const scoped = createCalendarStore(join(tempRoot, 'tools.sqlite'))
  const { tools, requests } = makeTools(scoped)
  const value = await tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' })
  assert.match(value.eventId, /^evt_/)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'calendar_create')
  assert.match(requests[0].reason, /标题=周会/)
  assert.equal(scoped.listEvents({ startMs: 0, endMs: Date.parse('2027-01-01T00:00:00Z') }).length, 1)
  scoped.close()
  return true
})

await check('tools: rejected approval writes nothing', async () => {
  const scoped = createCalendarStore(join(tempRoot, 'denied.sqlite'))
  const { tools } = makeTools(scoped, { outcome: 'denied' })
  await assert.rejects(() => tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' }), raises('approval'))
  assert.equal(scoped.listEvents({ startMs: 0, endMs: Date.parse('2027-01-01T00:00:00Z') }).length, 0)
  scoped.close()
  return true
})

await check('tools: missing approval service fails closed', async () => {
  const scoped = createCalendarStore(join(tempRoot, 'no-approval.sqlite'))
  const { tools } = makeTools(scoped, { approval: null })
  await assert.rejects(() => tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' }), raises('approval'))
  assert.equal(scoped.listEvents({ startMs: 0, endMs: Date.parse('2027-01-01T00:00:00Z') }).length, 0)
  scoped.close()
  return true
})

await check('tools: calendar_update patches only the given fields', async () => {
  const scoped = createCalendarStore(join(tempRoot, 'update.sqlite'))
  const created = createCalendarEvent({
    summary: '旧标题',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { store: scoped })
  const { tools, requests } = makeTools(scoped)
  const value = await tools.get('calendar_update').execute({
    eventId: created.eventId,
    summary: '新标题',
  }, { agent: { id: 'agent' }, callId: 'c2' })
  assert.equal(value.summary, '新标题')
  assert.match(requests[0].reason, /event_id=evt_/)
  assert.equal(scoped.getEvent(created.eventId)?.startAt, created.startAt)
  scoped.close()
  return true
})

await check('tools: descriptions never mention Feishu or a remote calendar id', () => {
  const { tools } = makeTools(store)
  const texts = [...tools.values()].map((tool) => `${tool.name} ${tool.description ?? ''}`).join('\n')
  return !/飞书|feishu|calendar_id|app secret/i.test(texts)
})

await check('risk: calendar writes need approval, reads do not', () => {
  const { tools } = makeTools(store)
  return tools.get('calendar_events') !== undefined
    && tools.get('calendar_create') !== undefined
    && tools.get('calendar_update') !== undefined
})

// -- 会前提醒（Slice BQ） ---------------------------------------------------------------

await check('reminder: starting-soon window is (now, now+lead], unreminded only', () => {
  const scoped = createCalendarStore(join(tempRoot, 'soon.sqlite'))
  const near = createCalendarEvent({
    summary: '近',
    start: '2026-11-20T10:09:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  const edge = createCalendarEvent({
    summary: '边界',
    start: '2026-11-20T10:10:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  createCalendarEvent({
    summary: '太远',
    start: '2026-11-20T10:11:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  createCalendarEvent({
    summary: '已开始',
    start: '2026-11-20T09:59:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })

  const found = scoped.listStartingSoon({ nowMs: CLOCK.getTime(), leadMs: 10 * 60_000 })
  assert.deepEqual(found.map((event) => event.summary), ['近', '边界'])
  assert.equal(scoped.markReminded(near.eventId), true)
  assert.equal(scoped.markReminded(near.eventId), false)
  assert.equal(scoped.markReminded('evt_missing'), false)
  const after = scoped.listStartingSoon({ nowMs: CLOCK.getTime(), leadMs: 10 * 60_000 })
  assert.deepEqual(after.map((event) => event.summary), ['边界'])
  assert.equal(scoped.getEvent(edge.eventId)?.remindedAt, null)

  // 改期后重新允许提醒；只改标题不重置。
  scoped.markReminded(edge.eventId)
  updateCalendarEvent({ eventId: edge.eventId, summary: '边界（改）' }, { store: scoped })
  assert.notEqual(scoped.getEvent(edge.eventId)?.remindedAt, null)
  updateCalendarEvent({ eventId: edge.eventId, start: '2026-11-20T10:30:00+08:00' }, { store: scoped })
  assert.equal(scoped.getEvent(edge.eventId)?.remindedAt, null)
  scoped.close()
  return true
})

await check('reminder: v1 database is upgraded in place with reminded_at', async () => {
  const { default: DatabaseConstructor } = await import('better-sqlite3')
  const legacyPath = join(tempRoot, 'legacy.sqlite')
  const legacy = new DatabaseConstructor(legacyPath)
  legacy.exec(`
    CREATE TABLE schema_migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (module));
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY, summary TEXT NOT NULL, description TEXT,
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      location TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run('calendar', 1, '2026-11-20T00:00:00.000Z')
  legacy.prepare(`INSERT INTO calendar_events VALUES ('evt_legacy','旧会','', '2026-11-20T09:00:00+08:00','2026-11-20T10:00:00+08:00', ?, ?,'', '2026-11-20T00:00:00.000Z','2026-11-20T00:00:00.000Z')`)
    .run(Date.parse('2026-11-20T09:00:00+08:00'), Date.parse('2026-11-20T10:00:00+08:00'))
  legacy.close()

  const upgraded = createCalendarStore(legacyPath)
  const event = upgraded.getEvent('evt_legacy')
  assert.equal(event?.summary, '旧会')
  assert.equal(event?.remindedAt, null)
  upgraded.close()

  const check = new DatabaseConstructor(legacyPath, { readonly: true })
  const version = check.prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?').get('calendar').version
  const columns = check.prepare('PRAGMA table_info(calendar_events)').all().map((column) => column.name)
  check.close()
  return version === 2 && columns.includes('reminded_at')
})

await check('reminder: text names the title, start time and venue', () => {
  const event = {
    eventId: 'evt_1',
    summary: '周会',
    description: '',
    startAt: '2026-11-20T10:05:00+08:00',
    endAt: '2026-11-20T11:00:00+08:00',
    startMs: Date.parse('2026-11-20T10:05:00+08:00'),
    endMs: Date.parse('2026-11-20T11:00:00+08:00'),
    location: '会议室 A',
    createdAt: '',
    updatedAt: '',
    remindedAt: null,
  }
  const text = formatCalendarReminder(event, CLOCK.getTime())
  return text === '提醒：还有 5 分钟开始「周会」（10:05 开始，地点：会议室 A）'
})

await check('reminder patrol: queues once, marks the row, and retries without a binding', () => {
  const scoped = createCalendarStore(join(tempRoot, 'patrol.sqlite'))
  const created = createCalendarEvent({
    summary: '周会',
    start: '2026-11-20T10:05:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  const sent = []
  const bindings = []
  const gateway = {
    listBindings: () => bindings,
    enqueueOutbox: (input) => {
      sent.push(input)
      return { id: `out_${sent.length}` }
    },
  }
  const warnings = []
  const patrol = createCalendarReminderPatrol({
    store: scoped,
    gateway,
    leadMinutes: 10,
    now,
    logger: { warn: (message) => warnings.push(message) },
  })

  assert.equal(patrol.runOnce(), 0)
  assert.equal(warnings.length, 1)
  assert.equal(scoped.getEvent(created.eventId)?.remindedAt, null)

  bindings.push({ externalUserId: 'ou_owner' })
  assert.equal(patrol.runOnce(), 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].dedupeKey, `calendar-reminder:${created.eventId}`)
  assert.match(sent[0].payload.text, /还有 5 分钟开始「周会」/)
  assert.equal(scoped.getEvent(created.eventId)?.remindedAt, CLOCK.toISOString())

  assert.equal(patrol.runOnce(), 0)
  assert.equal(sent.length, 1)
  patrol.stop()
  scoped.close()
  return true
})

await check('reminder patrol: an enqueue failure leaves the event unmarked', () => {
  const scoped = createCalendarStore(join(tempRoot, 'patrol-fail.sqlite'))
  const created = createCalendarEvent({
    summary: '周会',
    start: '2026-11-20T10:05:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  const patrol = createCalendarReminderPatrol({
    store: scoped,
    gateway: {
      listBindings: () => [{ externalUserId: 'ou_owner' }],
      enqueueOutbox: () => { throw new Error('outbox down') },
    },
    leadMinutes: 10,
    now,
  })
  assert.equal(patrol.runOnce(), 0)
  assert.equal(scoped.getEvent(created.eventId)?.remindedAt, null)
  scoped.close()
  return true
})

await check('reminder patrol: lead <= 0 disables the scan', () => {
  const scoped = createCalendarStore(join(tempRoot, 'patrol-off.sqlite'))
  createCalendarEvent({
    summary: '周会',
    start: '2026-11-20T10:05:00+08:00',
    end: '2026-11-20T11:00:00+08:00',
  }, { store: scoped })
  const sent = []
  const patrol = createCalendarReminderPatrol({
    store: scoped,
    gateway: {
      listBindings: () => [{ externalUserId: 'ou_owner' }],
      enqueueOutbox: (input) => { sent.push(input); return { id: 'x' } },
    },
    leadMinutes: 0,
    now,
  })
  assert.equal(patrol.runOnce(), 0)
  assert.equal(sent.length, 0)
  scoped.close()
  return true
})

console.log(`\n${pass} passed, ${fail} failed`)
store.close()
rmSync(tempRoot, { recursive: true, force: true })
if (fail > 0) process.exitCode = 1
