/**
 * 飞书日历 v4 客户端（J4）。
 *
 * 只暴露本能力需要的五个动作：列日历、建日历、列事件、建事件、改事件。
 * 客户端按 tenant_access_token 工作，**不读个人主日历**。
 *
 * 错误口径：飞书在缺 scope 时返回 `99991672`（HTTP 400）。SDK 对非 2xx 会抛
 * AxiosError（`response.data` 里有 code/msg），对 200 且 code≠0 则不抛。
 * 两条路径都在这里收敛成 `CalendarError`，scope 缺失映射为 `calendar-scope`。
 */

import { resolveLarkDomain } from '@dsh-wfxm/feishu'

export type CalendarErrorCode = 'config' | 'calendar-scope' | 'calendar-api' | 'protocol' | 'approval'

export class CalendarError extends Error {
  readonly code: CalendarErrorCode

  constructor(code: CalendarErrorCode, message: string) {
    super(message)
    this.name = 'CalendarError'
    this.code = code
  }
}

export interface CalendarRef {
  calendarId: string
  summary: string
}

/** 飞书事件的时间对象；`date`（全天）与 `timestamp`（秒级字符串）二选一。 */
export interface CalendarEventTime {
  date?: string
  timestamp?: string
  timezone?: string
}

export interface CalendarEventRecord {
  eventId: string
  summary: string
  start: CalendarEventTime | null
  end: CalendarEventTime | null
  location: string
}

export interface CalendarEventInput {
  summary?: string
  description?: string
  start?: string
  end?: string
}

export interface CalendarApi {
  listCalendars(): Promise<CalendarRef[]>
  createCalendar(summary: string): Promise<CalendarRef>
  listEvents(calendarId: string, range: { startMs: number; endMs: number }): Promise<CalendarEventRecord[]>
  createEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEventRecord>
  patchEvent(calendarId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEventRecord>
}

// -- narrow SDK seam (satisfied by `@larksuiteoapi/node-sdk` Client) ---------------------

export interface LarkResponse<T> {
  code?: number
  msg?: string
  data?: T
}

interface RawEvent {
  event_id?: string
  summary?: string
  start_time?: CalendarEventTime
  end_time?: CalendarEventTime
  location?: { name?: string }
}

interface RawCalendar {
  calendar_id?: string
  summary?: string
}

export interface CalendarSdkClient {
  calendar: {
    calendar: {
      list(input?: { params?: { page_size?: number; page_token?: string } }): Promise<LarkResponse<{
        calendar_list?: RawCalendar[]
        has_more?: boolean
        page_token?: string
      }>>
      create(input: { data: { summary: string; permissions?: 'private' } }): Promise<LarkResponse<{
        calendar?: RawCalendar
      }>>
    }
    calendarEvent: {
      list(input: {
        path: { calendar_id: string }
        params?: { page_size?: number; start_time?: string; end_time?: string }
      }): Promise<LarkResponse<{ items?: RawEvent[]; has_more?: boolean; page_token?: string }>>
      create(input: {
        path: { calendar_id: string }
        params?: { user_id_type?: 'open_id' | 'union_id' | 'user_id' }
        data: { summary?: string; description?: string; start_time: unknown; end_time: unknown }
      }): Promise<LarkResponse<{ event?: RawEvent }>>
      patch(input: {
        path: { calendar_id: string; event_id: string }
        params?: { user_id_type?: 'open_id' | 'union_id' | 'user_id' }
        data: { summary?: string; description?: string; start_time?: unknown; end_time?: unknown }
      }): Promise<LarkResponse<{ event?: RawEvent }>>
    }
  }
}

/** 缺 scope 的飞书错误码；见 https://open.feishu.cn/document/…/error-code */
const SCOPE_ERROR_CODES = new Set([99991672, 99991679])

const SCOPE_HINT =
  '日历权限未开通：请为应用开通 calendar:calendar:readonly 与 calendar:calendar 并发布版本。'

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

interface ExtractedError {
  code: number | null
  message: string
}

/** 从 AxiosError / SDK 错误 / 字符串里取出飞书 code 与 msg。 */
export function extractLarkError(error: unknown): ExtractedError {
  const record = error as {
    code?: unknown
    msg?: unknown
    message?: unknown
    response?: { data?: { code?: unknown; msg?: unknown } }
  } | null
  const data = record?.response?.data
  const code = asNumber(data?.code) ?? asNumber(record?.code)
  const msg = typeof data?.msg === 'string' && data.msg !== ''
    ? data.msg
    : typeof record?.msg === 'string' && record.msg !== ''
      ? record.msg
      : messageOf(error)
  return { code, message: msg }
}

function scopeError(code: number | null, detail: string): CalendarError {
  return new CalendarError('calendar-scope', `${SCOPE_HINT}（飞书错误 ${code ?? 'scope'}：${detail}）`)
}

/** 抛出的错误 → CalendarError。scope 缺失优先于一般 API 错误。 */
export function mapLarkError(error: unknown): CalendarError {
  if (error instanceof CalendarError) return error
  const { code, message } = extractLarkError(error)
  if (code !== null && SCOPE_ERROR_CODES.has(code)) return scopeError(code, message)
  if (/scope|permission|权限/i.test(message)) return scopeError(code, message)
  return new CalendarError('calendar-api', `飞书日历接口失败：${message}`)
}

function ensureResponse<T>(response: LarkResponse<T>, action: string): T {
  const code = asNumber(response?.code)
  if (code !== null && code !== 0) {
    if (SCOPE_ERROR_CODES.has(code)) throw scopeError(code, response?.msg ?? '')
    throw new CalendarError('calendar-api', `飞书日历接口失败（${action}，code=${code}）：${response?.msg ?? ''}`)
  }
  const data = response?.data
  if (data === undefined || data === null) {
    throw new CalendarError('calendar-api', `飞书日历接口返回空数据（${action}）`)
  }
  return data
}

function toRef(raw: RawCalendar): CalendarRef {
  const calendarId = typeof raw.calendar_id === 'string' ? raw.calendar_id : ''
  if (calendarId === '') throw new CalendarError('calendar-api', '飞书返回的日历缺少 calendar_id')
  return { calendarId, summary: typeof raw.summary === 'string' ? raw.summary : '' }
}

function toEvent(raw: RawEvent): CalendarEventRecord {
  const eventId = typeof raw.event_id === 'string' ? raw.event_id : ''
  if (eventId === '') throw new CalendarError('calendar-api', '飞书返回的日程缺少 event_id')
  return {
    eventId,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    start: raw.start_time ?? null,
    end: raw.end_time ?? null,
    location: raw.location?.name ?? '',
  }
}

function timePart(iso: string | undefined): { timestamp: string; timezone: string } | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new CalendarError('protocol', `时间格式无效：${iso}`)
  return { timestamp: String(Math.floor(ms / 1000)), timezone: 'Asia/Shanghai' }
}

/** 纯映射层：注入假 client 即可在无网络下断言参数与错误口径。 */
export function createCalendarApi(client: CalendarSdkClient): CalendarApi {
  async function call<T>(action: string, run: () => Promise<LarkResponse<T>>): Promise<T> {
    let response: LarkResponse<T>
    try {
      response = await run()
    } catch (error) {
      throw mapLarkError(error)
    }
    return ensureResponse(response, action)
  }

  return {
    async listCalendars() {
      const calendars: CalendarRef[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const data = await call('list calendars', () => client.calendar.calendar.list({
          params: { page_size: 100, ...pageToken === undefined ? {} : { page_token: pageToken } },
        }))
        for (const raw of data.calendar_list ?? []) calendars.push(toRef(raw))
        if (data.has_more !== true || typeof data.page_token !== 'string' || data.page_token === '') break
        pageToken = data.page_token
      }
      return calendars
    },

    async createCalendar(summary: string) {
      const data = await call('create calendar', () => client.calendar.calendar.create({
        data: { summary, permissions: 'private' },
      }))
      if (data.calendar === undefined) {
        throw new CalendarError('calendar-api', '创建日历成功但未返回日历对象')
      }
      return toRef(data.calendar)
    },

    async listEvents(calendarId, range) {
      const events: CalendarEventRecord[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const data = await call('list events', () => client.calendar.calendarEvent.list({
          path: { calendar_id: calendarId },
          params: {
            page_size: 100,
            start_time: String(Math.floor(range.startMs / 1000)),
            end_time: String(Math.floor(range.endMs / 1000)),
            ...pageToken === undefined ? {} : { page_token: pageToken },
          },
        }))
        for (const raw of data.items ?? []) events.push(toEvent(raw))
        if (data.has_more !== true || typeof data.page_token !== 'string' || data.page_token === '') break
        pageToken = data.page_token
      }
      return events
    },

    async createEvent(calendarId, input) {
      const start = timePart(input.start)
      const end = timePart(input.end)
      if (start === undefined || end === undefined) {
        throw new CalendarError('protocol', '创建日程必须同时提供开始与结束时间')
      }
      const data = await call('create event', () => client.calendar.calendarEvent.create({
        path: { calendar_id: calendarId },
        data: {
          ...input.summary === undefined ? {} : { summary: input.summary },
          ...input.description === undefined ? {} : { description: input.description },
          start_time: start,
          end_time: end,
        },
      }))
      if (data.event === undefined) {
        throw new CalendarError('calendar-api', '创建日程成功但未返回日程对象')
      }
      return toEvent(data.event)
    },

    async patchEvent(calendarId, eventId, input) {
      const start = timePart(input.start)
      const end = timePart(input.end)
      const data = await call('patch event', () => client.calendar.calendarEvent.patch({
        path: { calendar_id: calendarId, event_id: eventId },
        data: {
          ...input.summary === undefined ? {} : { summary: input.summary },
          ...input.description === undefined ? {} : { description: input.description },
          ...start === undefined ? {} : { start_time: start },
          ...end === undefined ? {} : { end_time: end },
        },
      }))
      if (data.event === undefined) return { eventId, summary: input.summary ?? '', start: null, end: null, location: '' }
      return toEvent(data.event)
    },
  }
}

/** 生产入口：用 bot 凭据建一个租户身份 client（与飞书渠道共用凭据文件）。 */
export async function createLarkCalendarApi(
  credentials: { appId: string; appSecret: string; domain?: string | null },
): Promise<CalendarApi> {
  const lark = await import('@larksuiteoapi/node-sdk')
  const client = new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: resolveLarkDomain(credentials.domain, lark.Domain as unknown as Record<string, string>),
  })
  return createCalendarApi(client as unknown as CalendarSdkClient)
}
