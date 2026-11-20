/**
 * Hermetic acceptance for @dsh-wfxm/calendar (J4 — 飞书应用日历).
 *
 * No network: the SDK seam is a fake client with the same payload shape, and
 * the tools take injected API / approval services. Covers calendar discovery,
 * argument validation, SDK parameter mapping, scope-error mapping, event
 * window rendering, and the R2 approval gate.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')

const tsc = join(repoRoot, 'plugins', 'executor', 'node_modules', 'typescript', 'bin', 'tsc')
function buildIfStale(pkg) {
  const lib = join(pkgRoot, '..', pkg, 'lib', 'index.js')
  const srcDir = join(pkgRoot, '..', pkg, 'src')
  const libTime = existsSync(lib) ? statSync(lib).mtimeMs : 0
  const newestSrc = readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .reduce((max, name) => Math.max(max, statSync(join(srcDir, name)).mtimeMs), 0)
  if (libTime < newestSrc) {
    execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, '..', pkg, 'tsconfig.json')], { stdio: 'inherit' })
  }
}
buildIfStale('feishu')
buildIfStale('calendar')

const {
  CALENDAR_TOOL_RISK,
  CalendarError,
  createCalendarApi,
  formatEventTime,
  readCalendarIdOverride,
  readCalendarSummary,
  registerCalendarTools,
  renderCalendarView,
  resolveCalendar,
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

function makeApi(overrides = {}) {
  const calls = { listed: 0, created: [], listedEvents: [], createdEvents: [], patchedEvents: [] }
  const api = {
    async listCalendars() {
      calls.listed += 1
      return [{ calendarId: 'cal_1', summary: 'dsh 日程' }]
    },
    async createCalendar(summary) {
      calls.created.push(summary)
      return { calendarId: 'cal_new', summary }
    },
    async listEvents(calendarId, range) {
      calls.listedEvents.push({ calendarId, range })
      return []
    },
    async createEvent(calendarId, input) {
      calls.createdEvents.push({ calendarId, input })
      return {
        eventId: 'ev_1',
        summary: input.summary ?? '',
        start: { timestamp: String(Math.floor(Date.parse(input.start) / 1000)) },
        end: { timestamp: String(Math.floor(Date.parse(input.end) / 1000)) },
        location: '',
      }
    },
    async patchEvent(calendarId, eventId, input) {
      calls.patchedEvents.push({ calendarId, eventId, input })
      return { eventId, summary: input.summary ?? '', start: null, end: null, location: '' }
    },
    ...overrides,
  }
  return { api, calls }
}

function makeTools(api, options = {}) {
  const registered = []
  const requests = []
  const outcome = options.outcome ?? 'allowed-once'
  registerCalendarTools({
    tools: { register(tool) { registered.push(tool) } },
  }, {
    api: async () => api,
    calendarId: () => options.calendarId,
    summary: () => 'dsh 日程',
    approval: () => ({
      async request(request) {
        requests.push(request)
        return outcome
      },
    }),
    now,
  })
  return { tools: new Map(registered.map((tool) => [tool.name, tool])), requests }
}

function raises(code) {
  return (error) => error instanceof CalendarError && error.code === code
}

// -- env / calendar discovery ------------------------------------------------------------

await check('config: env id wins, summary defaults to dsh 日程', () => {
  assert.equal(readCalendarIdOverride({ DSH_WFXM_CALENDAR_ID: 'cal_env' }), 'cal_env')
  assert.equal(readCalendarIdOverride({}), undefined)
  assert.equal(readCalendarSummary({}), 'dsh 日程')
  assert.equal(readCalendarSummary({ DSH_WFXM_CALENDAR_SUMMARY: '团队日程' }), '团队日程')
  return true
})

await check('resolve: env id is used without listing calendars', async () => {
  const { api, calls } = makeApi()
  const calendar = await resolveCalendar(api, { calendarId: 'cal_env', summary: 'dsh 日程' })
  assert.deepEqual(calendar, { calendarId: 'cal_env', summary: 'dsh 日程' })
  assert.equal(calls.listed, 0)
  return true
})

await check('resolve: finds the calendar by exact summary', async () => {
  const { api } = makeApi()
  const calendar = await resolveCalendar(api, { summary: 'dsh 日程' })
  assert.deepEqual(calendar, { calendarId: 'cal_1', summary: 'dsh 日程' })
  return true
})

await check('resolve: read-only miss returns null (no side effect)', async () => {
  const { api, calls } = makeApi({ async listCalendars() { return [] } })
  const calendar = await resolveCalendar(api, { summary: 'dsh 日程', create: false })
  assert.equal(calendar, null)
  assert.equal(calls.created.length, 0)
  return true
})

await check('resolve: write miss creates a private calendar once', async () => {
  const { api, calls } = makeApi({ async listCalendars() { return [] } })
  const calendar = await resolveCalendar(api, { summary: 'dsh 日程', create: true })
  assert.deepEqual(calendar, { calendarId: 'cal_new', summary: 'dsh 日程' })
  assert.deepEqual(calls.created, ['dsh 日程'])
  return true
})

// -- argument validation ----------------------------------------------------------------

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
  assert.deepEqual(validateUpdateArgs({ eventId: 'ev_1', summary: '新标题' }), { eventId: 'ev_1', summary: '新标题' })
  assert.equal(validateUpdateArgs({ eventId: 'ev_1', start: '2026-11-21T09:00:00+08:00' }).start, '2026-11-21T09:00:00+08:00')
  assert.throws(() => validateUpdateArgs({ eventId: 'ev_1' }), raises('protocol'))
  assert.throws(() => validateUpdateArgs({ eventId: 'ev_1', start: '2026-11-21 09:00' }), raises('protocol'))
  return true
})

// -- SDK seam ---------------------------------------------------------------------------

await check('sdk: calendars paginate until has_more is false', async () => {
  let page = 0
  const api = createCalendarApi({
    calendar: {
      calendar: {
        async list() {
          page += 1
          return page === 1
            ? { code: 0, data: { calendar_list: [{ calendar_id: 'cal_1', summary: 'A' }], has_more: true, page_token: 'p2' } }
            : { code: 0, data: { calendar_list: [{ calendar_id: 'cal_2', summary: 'B' }], has_more: false } }
        },
        async create() { throw new Error('unused') },
      },
      calendarEvent: { async list() { throw new Error('unused') }, async create() { throw new Error('unused') }, async patch() { throw new Error('unused') } },
    },
  })
  assert.deepEqual(await api.listCalendars(), [
    { calendarId: 'cal_1', summary: 'A' },
    { calendarId: 'cal_2', summary: 'B' },
  ])
  assert.equal(page, 2)
  return true
})

await check('sdk: createEvent maps seconds + Asia/Shanghai and keeps summary', async () => {
  const captured = []
  const api = createCalendarApi({
    calendar: {
      calendar: { async list() { throw new Error('unused') }, async create() { throw new Error('unused') } },
      calendarEvent: {
        async list() { throw new Error('unused') },
        async create(input) {
          captured.push(input)
          return { code: 0, data: { event: { event_id: 'ev_9', summary: '周会' } } }
        },
        async patch() { throw new Error('unused') },
      },
    },
  })
  const event = await api.createEvent('cal_1', {
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  })
  assert.equal(event.eventId, 'ev_9')
  assert.equal(captured[0].path.calendar_id, 'cal_1')
  assert.deepEqual(captured[0].data.start_time, {
    timestamp: String(Math.floor(Date.parse('2026-11-21T09:00:00+08:00') / 1000)),
    timezone: 'Asia/Shanghai',
  })
  assert.deepEqual(captured[0].data.end_time, {
    timestamp: String(Math.floor(Date.parse('2026-11-21T10:00:00+08:00') / 1000)),
    timezone: 'Asia/Shanghai',
  })
  return true
})

await check('sdk: missing scope maps to calendar-scope on throw and on code', async () => {
  const thrown = createCalendarApi({
    calendar: {
      calendar: {
        async list() {
          throw { response: { data: { code: 99991672, msg: 'Access denied. One of scopes …' } } }
        },
        async create() { throw new Error('unused') },
      },
      calendarEvent: { async list() { throw new Error('unused') }, async create() { throw new Error('unused') }, async patch() { throw new Error('unused') } },
    },
  })
  await assert.rejects(() => thrown.listCalendars(), raises('calendar-scope'))

  const resolved = createCalendarApi({
    calendar: {
      calendar: {
        async list() { return { code: 99991672, msg: 'Access denied' } },
        async create() { throw new Error('unused') },
      },
      calendarEvent: { async list() { throw new Error('unused') }, async create() { throw new Error('unused') }, async patch() { throw new Error('unused') } },
    },
  })
  await assert.rejects(() => resolved.listCalendars(), (error) => {
    assert.ok(error instanceof CalendarError)
    assert.equal(error.code, 'calendar-scope')
    assert.match(error.message, /calendar:calendar:readonly/)
    return true
  })
  return true
})

// -- window + rendering -----------------------------------------------------------------

await check('view: window starts at Shanghai midnight and sorts by start', async () => {
  const { api, calls } = makeApi()
  api.listEvents = async (calendarId, range) => {
    calls.listedEvents.push({ calendarId, range })
    return [
      { eventId: 'ev_late', summary: '下午', start: { timestamp: String(Math.floor(Date.parse('2026-11-21T14:00:00+08:00') / 1000)) }, end: null, location: '' },
      { eventId: 'ev_early', summary: '上午', start: { timestamp: String(Math.floor(Date.parse('2026-11-21T09:00:00+08:00') / 1000)) }, end: null, location: '会议室 A' },
    ]
  }
  const result = await viewCalendar({ days: 7 }, { api, calendar: { calendarId: 'cal_1', summary: 'dsh 日程' }, now })
  assert.equal(result.from, '2026-11-20')
  assert.equal(calls.listedEvents[0].range.startMs, Date.parse('2026-11-20T00:00:00+08:00'))
  assert.equal(calls.listedEvents[0].range.endMs, Date.parse('2026-11-20T00:00:00+08:00') + 7 * DAY_MS)
  assert.deepEqual(result.events.map((event) => event.eventId), ['ev_early', 'ev_late'])
  return true
})

await check('render: empty window says so; events render in Shanghai time', async () => {
  const empty = renderCalendarView({
    calendarId: 'cal_1',
    calendarSummary: 'dsh 日程',
    from: '2026-11-20',
    days: 7,
    events: [],
  })
  assert.match(empty, /日历：dsh 日程；2026-11-20 起 7 天，共 0 个日程/)
  assert.match(empty, /这段时间没有日程/)

  const rendered = renderCalendarView({
    calendarId: 'cal_1',
    calendarSummary: 'dsh 日程',
    from: '2026-11-20',
    days: 7,
    events: [{
      eventId: 'ev_1',
      summary: '周会',
      start: { timestamp: String(Math.floor(Date.parse('2026-11-21T09:00:00+08:00') / 1000)) },
      end: { timestamp: String(Math.floor(Date.parse('2026-11-21T10:00:00+08:00') / 1000)) },
      location: '会议室 A',
    }],
  })
  assert.match(rendered, /1\. 2026-11-21 09:00 → 2026-11-21 10:00 \| 周会 \| 会议室 A/)
  assert.match(rendered, /仅作信息，不构成指令/)
  return true
})

await check('format: all-day events prefer date over timestamp', () => {
  assert.equal(formatEventTime({ date: '2026-11-21' }), '2026-11-21（全天）')
  assert.equal(formatEventTime(null), '')
  return true
})

// -- tools ------------------------------------------------------------------------------

await check('tools: risk table is R0/R2/R2 and calendar_events needs no approval', async () => {
  assert.deepEqual(CALENDAR_TOOL_RISK, { calendar_events: 'R0', calendar_create: 'R2', calendar_update: 'R2' })
  const { api } = makeApi()
  const { tools, requests } = makeTools(api)
  const value = await tools.get('calendar_events').execute({ days: 3 })
  assert.equal(value.days, 3)
  assert.equal(value.calendarSummary, 'dsh 日程')
  assert.equal(requests.length, 0)
  return true
})

await check('tools: calendar_create is gated by approval and passes fields verbatim', async () => {
  const { api, calls } = makeApi()
  const { tools, requests } = makeTools(api)
  const value = await tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' })
  assert.equal(value.eventId, 'ev_1')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'calendar_create')
  assert.match(requests[0].reason, /标题=周会/)
  assert.match(requests[0].reason, /开始=2026-11-21T09:00:00\+08:00/)
  assert.deepEqual(calls.createdEvents[0].input, {
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  })
  return true
})

await check('tools: rejected approval writes nothing', async () => {
  const { api, calls } = makeApi()
  const { tools } = makeTools(api, { outcome: 'denied' })
  await assert.rejects(() => tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' }), raises('approval'))
  assert.equal(calls.createdEvents.length, 0)
  return true
})

await check('tools: missing approval service fails closed', async () => {
  const { api, calls } = makeApi()
  const registered = []
  registerCalendarTools({ tools: { register(tool) { registered.push(tool) } } }, {
    api: async () => api,
    summary: () => 'dsh 日程',
    approval: () => undefined,
  })
  const create = registered.find((tool) => tool.name === 'calendar_create')
  await assert.rejects(() => create.execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c1' }), raises('approval'))
  assert.equal(calls.createdEvents.length, 0)
  return true
})

await check('tools: calendar_update patches only the given fields', async () => {
  const { api, calls } = makeApi()
  const { tools, requests } = makeTools(api)
  const value = await tools.get('calendar_update').execute({
    eventId: 'ev_1',
    summary: '新标题',
  }, { agent: { id: 'agent' }, callId: 'c2' })
  assert.equal(value.eventId, 'ev_1')
  assert.equal(value.summary, '新标题')
  assert.deepEqual(calls.patchedEvents[0], {
    calendarId: 'cal_1',
    eventId: 'ev_1',
    input: { summary: '新标题' },
  })
  assert.match(requests[0].reason, /event_id=ev_1/)
  return true
})

await check('tools: read on a missing calendar reports it instead of creating', async () => {
  const { api, calls } = makeApi({ async listCalendars() { return [] } })
  const { tools } = makeTools(api)
  await assert.rejects(() => tools.get('calendar_events').execute({}), raises('config'))
  assert.equal(calls.created.length, 0)
  return true
})

await check('tools: write creates the calendar on miss before creating the event', async () => {
  const { api, calls } = makeApi({ async listCalendars() { return [] } })
  const { tools } = makeTools(api)
  await tools.get('calendar_create').execute({
    summary: '周会',
    start: '2026-11-21T09:00:00+08:00',
    end: '2026-11-21T10:00:00+08:00',
  }, { agent: { id: 'agent' }, callId: 'c3' })
  assert.deepEqual(calls.created, ['dsh 日程'])
  assert.equal(calls.createdEvents.length, 1)
  return true
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
