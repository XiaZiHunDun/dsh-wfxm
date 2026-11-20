/**
 * Node → Python 的只读邮件查询（J1）。
 *
 * 只做三件事：把请求写成 JSON 从 stdin 交给脚本、收 stdout 的 JSON、
 * 把失败归类成可读错误。密码只存在于这次 stdin 中。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { MailAccount } from './config.js'

export type MailErrorCode = 'config' | 'auth' | 'network' | 'timeout' | 'protocol' | 'parse' | 'unavailable' | 'approval'

export class MailError extends Error {
  readonly code: MailErrorCode

  constructor(code: MailErrorCode, message: string) {
    super(message)
    this.name = 'MailError'
    this.code = code
  }
}

export interface MailSearchRequest {
  /** 服务端 TEXT 搜索；含非 ASCII 时改为本地过滤最近 200 封。 */
  query?: string
  from?: string
  subject?: string
  /** ISO 日期 `YYYY-MM-DD`。 */
  since?: string
  before?: string
  limit?: number
}

export interface MailMessageSummary {
  uid: number
  date: string
  from: string
  to: string
  subject: string
  sizeBytes: number
  seen: boolean
}

export interface MailSearchResult {
  mailbox: string
  total: number
  /** 实际扫描的头部数量（本地过滤时可能大于返回条数）。 */
  scanned: number
  localFilter: boolean
  messages: MailMessageSummary[]
}

export interface MailReadRequest {
  uid: number
  /** 正文最多返回多少字符（默认 4000，上限 20000）。 */
  maxChars?: number
}

export interface MailAttachmentInfo {
  name: string
  sizeBytes: number
}

export interface MailReadResult {
  uid: number
  date: string
  from: string
  to: string
  subject: string
  text: string
  truncated: boolean
  attachments: MailAttachmentInfo[]
}

export interface MailArchiveRequest {
  /** 要移动的邮件 uid；调用方已冻结目标集合。 */
  uids: number[]
  /** 目标归档夹。 */
  folder: string
}

export interface MailArchiveResult {
  folder: string
  moved: number
  uids: number[]
}

export interface MailFolderCountRequest {
  /** 目标夹；省略时由 Python 侧按 `role` 回落默认并尝试发现。 */
  folder?: string
  /** 断言用途：决定默认夹与候选名（sent/drafted/archive）。 */
  role?: 'archive' | 'sent' | 'drafted'
}

export interface MailFolderCountResult {
  folder: string
  /** 该夹的消息数（SELECT 的 EXISTS）。 */
  count: number
}

export interface MailDraftRequest {
  to: string
  subject: string
  body: string
  /** 目标草稿夹；省略时由 Python 侧发现或创建。 */
  folder?: string
}

export interface MailDraftResult {
  folder: string
  to: string
  subject: string
  messageId: string
}

export interface MailSendRequest {
  to: string
  subject: string
  body: string
  /** 已发送副本夹；省略时由 Python 侧发现。 */
  folder?: string
}

export interface MailSendResult {
  to: string
  subject: string
  messageId: string
  sentFolder: string
  /** 已发送副本是否写入成功；发送成功但副本失败时为 false。 */
  appended: boolean
  /** 副本失败原因；没有问题时为空串。 */
  warning: string
}

export interface QueryMailOptions {
  account: MailAccount
  /** 默认 `python3`（可用 `DSH_WFXM_PYTHON` 覆盖）。 */
  python?: string
  scriptPath?: string
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_SCRIPT = fileURLToPath(new URL('../scripts/mail-query.py', import.meta.url))

function errorCode(value: unknown): MailErrorCode {
  if (value === 'config' || value === 'auth' || value === 'network'
    || value === 'timeout' || value === 'protocol' || value === 'parse') {
    return value
  }
  return 'protocol'
}

function runScript(
  payload: unknown,
  options: QueryMailOptions,
): Promise<Record<string, unknown>> {
  const python = options.python ?? process.env.DSH_WFXM_PYTHON ?? 'python3'
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT
  const timeoutMs = options.timeoutMs ?? 20_000

  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new MailError('timeout', `邮件查询超时（>${timeoutMs}ms）`)))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(() => reject(new MailError(
        'unavailable',
        code === 'ENOENT' ? `找不到 Python 解释器：${python}` : `无法启动邮件查询：${error.message}`,
      )))
    })
    child.on('close', (code) => {
      const text = stdout.trim()
      if (text === '') {
        finish(() => reject(new MailError(
          'parse',
          `邮件查询没有输出（退出码 ${code ?? 'null'}）${stderr.trim() === '' ? '' : `：${stderr.trim()}`}`,
        )))
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        finish(() => reject(new MailError('parse', `邮件查询输出不是 JSON：${text.slice(0, 200)}`)))
        return
      }
      if (parsed === null || typeof parsed !== 'object') {
        finish(() => reject(new MailError('parse', '邮件查询输出不是对象')))
        return
      }
      const record = parsed as Record<string, unknown>
      if (record.ok === false) {
        const message = typeof record.message === 'string' ? record.message : '邮件查询失败'
        finish(() => reject(new MailError(errorCode(record.code), message)))
        return
      }
      finish(() => resolve(record))
    })

    child.stdin.end(JSON.stringify(payload))
  })
}

export async function queryMail(
  request: MailSearchRequest | MailReadRequest | MailArchiveRequest | MailFolderCountRequest | MailDraftRequest | MailSendRequest,
  options: QueryMailOptions & { action: 'search' | 'read' | 'archive' | 'count' | 'draft' | 'send' },
): Promise<Record<string, unknown>> {
  return runScript({ action: options.action, account: options.account, request }, options)
}

export async function searchMail(
  request: MailSearchRequest,
  options: QueryMailOptions,
): Promise<MailSearchResult> {
  const result = await queryMail(request, { ...options, action: 'search' })
  return {
    mailbox: String(result.mailbox ?? 'INBOX'),
    total: Number(result.total ?? 0),
    scanned: Number(result.scanned ?? 0),
    localFilter: result.localFilter === true,
    messages: Array.isArray(result.messages) ? result.messages as MailMessageSummary[] : [],
  }
}

export async function archiveMail(
  request: MailArchiveRequest,
  options: QueryMailOptions,
): Promise<MailArchiveResult> {
  const result = await queryMail(request, { ...options, action: 'archive' })
  return {
    folder: String(result.folder ?? request.folder),
    moved: Number(result.moved ?? 0),
    uids: Array.isArray(result.uids) ? result.uids as number[] : [],
  }
}

export async function countMailFolder(
  request: MailFolderCountRequest,
  options: QueryMailOptions,
): Promise<MailFolderCountResult> {
  const result = await queryMail(request, { ...options, action: 'count' })
  return {
    folder: String(result.folder ?? request.folder ?? ''),
    count: Number(result.count ?? 0),
  }
}

export async function draftMail(
  request: MailDraftRequest,
  options: QueryMailOptions,
): Promise<MailDraftResult> {
  const result = await queryMail(request, { ...options, action: 'draft' })
  return {
    folder: String(result.folder ?? request.folder ?? ''),
    to: String(result.to ?? request.to),
    subject: String(result.subject ?? request.subject),
    messageId: String(result.messageId ?? ''),
  }
}

export async function sendMail(
  request: MailSendRequest,
  options: QueryMailOptions,
): Promise<MailSendResult> {
  const result = await queryMail(request, { ...options, action: 'send' })
  return {
    to: String(result.to ?? request.to),
    subject: String(result.subject ?? request.subject),
    messageId: String(result.messageId ?? ''),
    sentFolder: String(result.sentFolder ?? request.folder ?? ''),
    appended: result.appended === true,
    warning: typeof result.warning === 'string' ? result.warning : '',
  }
}

export async function readMail(
  request: MailReadRequest,
  options: QueryMailOptions,
): Promise<MailReadResult> {
  const result = await queryMail(request, { ...options, action: 'read' })
  return {
    uid: Number(result.uid ?? request.uid),
    date: String(result.date ?? ''),
    from: String(result.from ?? ''),
    to: String(result.to ?? ''),
    subject: String(result.subject ?? ''),
    text: String(result.text ?? ''),
    truncated: result.truncated === true,
    attachments: Array.isArray(result.attachments)
      ? result.attachments as MailAttachmentInfo[]
      : [],
  }
}
