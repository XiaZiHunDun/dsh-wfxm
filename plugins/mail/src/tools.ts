/**
 * 邮件只读工具（J1）：`mail_search` / `mail_read`。
 *
 * 两个工具都是 R0、只读；模型看不到 IMAP、密码或 shell。
 * 未配置邮箱时返回可读错误，不影响其他工具。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readMailAccount, type MailAccount, type MailConfigResult } from './config.js'
import {
  MailError,
  readMail,
  searchMail,
  type MailReadRequest,
  type MailReadResult,
  type MailSearchRequest,
  type MailSearchResult,
} from './query.js'

export const name = 'dsh-wfxm-mail'

/** Host services this plugin consumes. */
export const inject = ['tools']

/** Risk baseline and owning port per tool, consumed by the startup self-check. */
export const MAIL_TOOL_RISK = {
  mail_search: 'R0',
  mail_read: 'R0',
} as const

export const MAIL_TOOL_PORT = 'Mail'

export interface ContextLike {
  tools?: { register(tool: unknown): void }
  logger?: { info?(message: string): void; warn?(message: string): void }
}

export interface MailToolsDeps {
  config?: () => MailConfigResult
  search?: (request: MailSearchRequest, options: { account: MailAccount }) => Promise<MailSearchResult>
  read?: (request: MailReadRequest, options: { account: MailAccount }) => Promise<MailReadResult>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new MailError('protocol', `${field} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function validateSearchArgs(args: Record<string, unknown>): MailSearchRequest {
  const request: MailSearchRequest = {}
  for (const field of ['query', 'from', 'subject'] as const) {
    const value = asString(args[field], field)
    if (value !== undefined) request[field] = value
  }
  for (const field of ['since', 'before'] as const) {
    const value = asString(args[field], field)
    if (value === undefined) continue
    if (!isIsoDate(value)) throw new MailError('protocol', `${field} must be YYYY-MM-DD, got ${value}`)
    request[field] = value
  }
  if (args.limit !== undefined && args.limit !== null) {
    const limit = Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new MailError('protocol', 'limit must be an integer between 1 and 50')
    }
    request.limit = limit
  }
  return request
}

export function validateReadArgs(args: Record<string, unknown>): MailReadRequest {
  const uid = Number(args.uid)
  if (!Number.isInteger(uid) || uid <= 0) throw new MailError('protocol', 'uid must be a positive integer')
  const request: MailReadRequest = { uid }
  if (args.maxChars !== undefined && args.maxChars !== null) {
    const maxChars = Number(args.maxChars)
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) {
      throw new MailError('protocol', 'maxChars must be an integer between 1 and 20000')
    }
    request.maxChars = maxChars
  }
  return request
}

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    uid: { type: 'number', required: true },
    date: { type: 'string', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    sizeBytes: { type: 'number', required: true },
    seen: { type: 'boolean', required: true },
  },
} as const

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mailbox: { type: 'string', required: true },
    total: { type: 'number', required: true },
    scanned: { type: 'number', required: true },
    localFilter: { type: 'boolean', required: true },
    messages: { type: 'array', required: true, items: MESSAGE_SCHEMA },
  },
} as const

const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    uid: { type: 'number', required: true },
    date: { type: 'string', required: true },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    subject: { type: 'string', required: true },
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    attachments: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          sizeBytes: { type: 'number', required: true },
        },
      },
    },
  },
} as const

function renderSearch(result: MailSearchResult): string {
  const header = `mailbox: ${result.mailbox}; total ${result.total}; showing ${result.messages.length}`
    + (result.localFilter ? `（本地过滤，扫描 ${result.scanned} 封）` : '')
  if (result.messages.length === 0) return `${header}\nno matching messages`
  const lines = result.messages.map(
    (item, index) => `${index + 1}. uid=${item.uid} ${item.date} | ${item.from} | ${item.subject}${item.seen ? '' : '（未读）'}`,
  )
  return `${header}\n${lines.join('\n')}`
}

function renderRead(result: MailReadResult): string {
  const attachments = result.attachments.length === 0
    ? 'attachments: none'
    : `attachments: ${result.attachments.map((item) => `${item.name} (${item.sizeBytes} bytes)`).join(', ')}`
  return [
    `uid: ${result.uid}`,
    `date: ${result.date}`,
    `from: ${result.from}`,
    `to: ${result.to}`,
    `subject: ${result.subject}`,
    attachments,
    '---',
    result.text === '' ? '(empty body)' : result.text,
    ...result.truncated ? ['[正文已截断]'] : [],
  ].join('\n')
}

export function registerMailTools(ctx: ContextLike, deps: MailToolsDeps = {}): void {
  const registry = ctx.tools
  if (registry === undefined) {
    throw new Error('mail: ctx.tools is missing; mount the plugin in a scope that owns the tools registry')
  }
  const loadConfig = deps.config ?? (() => readMailAccount())
  const doSearch = deps.search ?? (async (request, options) => searchMail(request, options))
  const doRead = deps.read ?? (async (request, options) => readMail(request, options))

  const accountOf = (): MailAccount => {
    const result = loadConfig()
    if (!result.ok) throw new MailError('config', result.message)
    return result.account
  }

  registry.register(defineTool({
    name: 'mail_search',
    description: 'Search recent messages in the read-only INBOX and return metadata (uid/date/from/subject/size/seen). Read-only: nothing is marked, moved or deleted.',
    parameters: {
      query: {
        type: 'string',
        description: 'Free-text search over headers/body. Non-ASCII terms fall back to a local filter over the most recent 200 messages.',
      },
      from: { type: 'string', description: 'Sender substring or address.' },
      subject: { type: 'string', description: 'Subject substring.' },
      since: { type: 'string', description: 'Only messages on/after this date (YYYY-MM-DD).' },
      before: { type: 'string', description: 'Only messages before this date (YYYY-MM-DD).' },
      limit: { type: 'number', description: '1..50, default 20.' },
    },
    output: {
      schema: SEARCH_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    async execute(args) {
      const request = validateSearchArgs(args as Record<string, unknown>)
      return doSearch(request, { account: accountOf() })
    },
  }))

  registry.register(defineTool({
    name: 'mail_read',
    description: 'Read one message by uid from the read-only INBOX. Body is plain text (HTML stripped) and truncated to maxChars; attachments are listed, never downloaded.',
    parameters: {
      uid: { type: 'number', required: true, description: 'Message uid from mail_search.' },
      maxChars: { type: 'number', description: 'Body limit, 1..20000, default 4000.' },
    },
    output: {
      schema: READ_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    async execute(args) {
      const request = validateReadArgs(args as Record<string, unknown>)
      return doRead(request, { account: accountOf() })
    },
  }))
}

export function apply(ctx: ContextLike): void {
  registerMailTools(ctx)
  ctx.logger?.info?.('[mail] read-only IMAP tools registered (mail_search, mail_read)')
}
