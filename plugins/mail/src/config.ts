/**
 * 邮件账号配置（J1）。
 *
 * 与飞书凭据同一个 seam：`~/.dsh/integrations/dsh-mail/config.json` 里只放
 * `secretRef`，真正的授权码在 `~/.dsh/integrations/dsh-mail/credentials.yaml`
 * 的 `refs:` 下。**不要**写进 dsh 的 `~/.dsh/.credentials.yaml`。
 * 环境变量（`DSH_WFXM_MAIL_*`）优先，生产推荐走 `/etc/dsh-wfxm/env`。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_MAIL_CONFIG_PATH = join(homedir(), '.dsh/integrations/dsh-mail/config.json')

/** 归档目标文件夹；不存在时由 IMAP 侧创建。 */
export const DEFAULT_ARCHIVE_FOLDER = 'Archive'

/** 草稿 / 已发送夹的默认名；实际名称由服务商候选项自动发现。 */
export const DEFAULT_DRAFT_FOLDER = 'Drafts'
export const DEFAULT_SENT_FOLDER = 'Sent'

/**
 * `DSH_WFXM_MAIL_ARCHIVE_FOLDER` 覆盖归档夹；空值回落默认。
 * 非 ASCII 名称由 Python 侧编码成 IMAP modified UTF-7。
 */
export function readArchiveFolder(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_WFXM_MAIL_ARCHIVE_FOLDER?.trim()
  return raw === undefined || raw === '' ? DEFAULT_ARCHIVE_FOLDER : raw
}

export function readDraftFolder(env: NodeJS.ProcessEnv = process.env): string {
  return readDraftFolderOverride(env) ?? DEFAULT_DRAFT_FOLDER
}

export function readSentFolder(env: NodeJS.ProcessEnv = process.env): string {
  return readSentFolderOverride(env) ?? DEFAULT_SENT_FOLDER
}

/** 显式覆盖值；未配置时返回 undefined，让 Python 侧按服务商候选名发现。 */
export function readDraftFolderOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_WFXM_MAIL_DRAFT_FOLDER?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

export function readSentFolderOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.DSH_WFXM_MAIL_SENT_FOLDER?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

export interface MailSmtp {
  host: string
  port: number
  secure: boolean
}

export type MailSmtpResult =
  | { ok: true; smtp: MailSmtp; source: 'env' | 'account' | 'derived' }
  | { ok: false; code: 'config'; message: string }

/**
 * SMTP 设置。主机优先级：`DSH_WFXM_MAIL_SMTP_HOST` → 配置文件 `account.smtp.host`
 * → 仅当 IMAP host 以 `imap.` 开头时替换为 `smtp.`；其它主机必须显式配置，
 * 避免把邮件发到猜出来的域名。
 */
export function readMailSmtp(
  account: MailAccount,
  env: NodeJS.ProcessEnv = process.env,
): MailSmtpResult {
  const envHost = env.DSH_WFXM_MAIL_SMTP_HOST?.trim()
  const configured = account.smtp?.host?.trim()
  const derived = /^imap\./i.test(account.host)
    ? account.host.replace(/^imap\./i, 'smtp.')
    : ''
  const host = envHost !== undefined && envHost !== '' ? envHost : configured !== undefined && configured !== '' ? configured : derived
  if (host === '') {
    return {
      ok: false,
      code: 'config',
      message: `未配置 SMTP 主机：请设置 DSH_WFXM_MAIL_SMTP_HOST（IMAP ${account.host} 无法自动推导）`,
    }
  }
  const rawPort = env.DSH_WFXM_MAIL_SMTP_PORT?.trim()
  const port = rawPort !== undefined && rawPort !== '' ? Number(rawPort) : account.smtp?.port ?? 465
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, code: 'config', message: 'SMTP 端口无效（DSH_WFXM_MAIL_SMTP_PORT）' }
  }
  const envSecure = env.DSH_WFXM_MAIL_SMTP_SECURE?.trim()
  const secure = envSecure !== undefined && envSecure !== ''
    ? envSecure !== '0'
    : account.smtp?.secure !== false
  const source = envHost !== undefined && envHost !== '' ? 'env' : configured !== undefined && configured !== '' ? 'account' : 'derived'
  return { ok: true, smtp: { host, port, secure }, source }
}
/**
 * 邮件凭据放在集成目录，**不要**复用 `~/.dsh/.credentials.yaml`：
 * 那是 dsh 自己的凭据库，`refs` 键必须是 POSIX 环境变量名；`mail/163`
 * 这类带 `/` 的 ref 会让整份凭据库解析失败，连带 LLM key 失效。
 */
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.dsh/integrations/dsh-mail/credentials.yaml')

export interface MailAccount {
  host: string
  port: number
  secure: boolean
  user: string
  /** 只用于 stdin 传给 Python；不落日志、不进 argv。 */
  password: string
  /** 配置文件里的 SMTP 覆盖；环境变量优先（见 `readMailSmtp`）。 */
  smtp?: { host?: string; port?: number; secure?: boolean }
}

export type MailConfigResult =
  | { ok: true; account: MailAccount; source: 'env' | 'file' }
  | { ok: false; code: 'config'; message: string }

export interface MailConfigOptions {
  configPath?: string
  credentialsPath?: string
  env?: NodeJS.ProcessEnv
}

/** 从 dsh 凭据库的 `refs:` 扁平映射中取一个值（与飞书同格式）。 */
export function resolveSecretRef(
  secretRef: string,
  options?: { credentialsPath?: string },
): { ok: true; value: string } | { ok: false; message: string } {
  const credentialsPath = options?.credentialsPath ?? DEFAULT_CREDENTIALS_PATH
  let text: string
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    return { ok: false, message: `cannot read credential store ${credentialsPath}: ${messageOf(error)}` }
  }
  let inRefs = false
  let refsIndent = -1
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (!inRefs) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        refsIndent = indent
      }
      continue
    }
    if (indent <= refsIndent) break
    const match = /^(\S+):\s*(.*)$/.exec(line.trimStart())
    if (match === null) continue
    if (match[1] === secretRef) {
      const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
      if (value === '') return { ok: false, message: `secretRef ${secretRef} is empty in ${credentialsPath}` }
      return { ok: true, value }
    }
  }
  return { ok: false, message: `secretRef ${secretRef} not found in ${credentialsPath}` }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readEnvAccount(env: NodeJS.ProcessEnv): MailAccount | null {
  const host = env.DSH_WFXM_MAIL_HOST?.trim()
  const user = env.DSH_WFXM_MAIL_USER?.trim()
  const password = env.DSH_WFXM_MAIL_PASSWORD
  if (!host || !user || !password) return null
  const port = Number(env.DSH_WFXM_MAIL_PORT ?? '993')
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 993,
    secure: env.DSH_WFXM_MAIL_SECURE !== '0',
    user,
    password,
  }
}

/**
 * 读取账号。缺失/字段不全返回 `ok:false`（工具层转成可读错误），
 * 不抛异常——邮件未配置时其他能力必须照常工作。
 */
export function readMailAccount(options: MailConfigOptions = {}): MailConfigResult {
  const env = options.env ?? process.env
  const fromEnv = readEnvAccount(env)
  if (fromEnv !== null) return { ok: true, account: fromEnv, source: 'env' }

  const configPath = options.configPath ?? env.DSH_WFXM_MAIL_CONFIG ?? DEFAULT_MAIL_CONFIG_PATH
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return {
      ok: false,
      code: 'config',
      message: `未配置邮箱：请创建 ${configPath}（含 account.host/port/user/secretRef）或设置 DSH_WFXM_MAIL_* 环境变量`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, code: 'config', message: `邮箱配置不是合法 JSON（${configPath}）：${messageOf(error)}` }
  }
  const account = (parsed as { account?: unknown }).account
  if (account === null || typeof account !== 'object') {
    return { ok: false, code: 'config', message: `邮箱配置缺少 account 对象（${configPath}）` }
  }
  const record = account as Record<string, unknown>

  const host = typeof record.host === 'string' ? record.host.trim() : ''
  const user = typeof record.user === 'string' ? record.user.trim() : ''
  if (host === '' || user === '') {
    return { ok: false, code: 'config', message: `邮箱配置缺少 account.host 或 account.user（${configPath}）` }
  }

  const rawPort = record.port
  const port = typeof rawPort === 'number' ? rawPort : Number(rawPort ?? 993)
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, code: 'config', message: `account.port 不是有效端口（${configPath}）` }
  }

  let password: string | null = null
  if (typeof record.password === 'string' && record.password !== '') {
    // 明文密码只作为临时排查手段；正式配置请用 secretRef。
    password = record.password
  } else if (typeof record.secretRef === 'string' && record.secretRef !== '') {
    const secret = resolveSecretRef(record.secretRef, {
      ...(options.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
    })
    if (!secret.ok) return { ok: false, code: 'config', message: secret.message }
    password = secret.value
  }
  if (password === null) {
    return { ok: false, code: 'config', message: `account 缺少 secretRef（${configPath}）` }
  }

  const smtp = record.smtp
  const smtpRecord = smtp !== null && typeof smtp === 'object' ? smtp as Record<string, unknown> : null
  const smtpHost = typeof smtpRecord?.host === 'string' ? smtpRecord.host.trim() : undefined
  const smtpPort = typeof smtpRecord?.port === 'number' ? smtpRecord.port : undefined
  const smtpSecure = typeof smtpRecord?.secure === 'boolean' ? smtpRecord.secure : undefined

  return {
    ok: true,
    source: 'file',
    account: {
      host,
      port,
      secure: record.secure !== false,
      user,
      password,
      ...smtpHost === undefined && smtpPort === undefined && smtpSecure === undefined
        ? {}
        : {
            smtp: {
              ...smtpHost === undefined ? {} : { host: smtpHost },
              ...smtpPort === undefined ? {} : { port: smtpPort },
              ...smtpSecure === undefined ? {} : { secure: smtpSecure },
            },
          },
    },
  }
}
