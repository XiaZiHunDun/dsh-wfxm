/**
 * J2 每日摘要调度（Slice BD）。
 *
 * 只做三件事：解析 `DSH_WFXM_MAIL_DIGEST_*` 配置、按显式时区算「今天到点没」、
 * 持久化「今天已发」的日期。真正的 IMAP 查询与投递由宿主注入，本文件不碰网络。
 *
 * 时区必须显式传入（默认 `Asia/Shanghai`）：进程 TZ 在 systemd / 测试 / 容器里
 * 都可能不同，依赖它会得到「有时 08:30，有时 00:30」。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_DIGEST_TIME_ZONE = 'Asia/Shanghai'

const AT_RE = /^(\d{1,2}):(\d{2})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface MailDigestConfig {
  /** 本地时间 `HH:MM`。 */
  at: string
  /** 投递渠道（① 的 `channel_id`）。 */
  channelId: string
  /** 固定会话；null = 取该渠道最近活跃线程。 */
  chatId: string | null
  /** 回看小时数，1..168。 */
  hours: number
  /** 最多展示封数，1..50。 */
  limit: number
  /** 只看未读。 */
  unreadOnly: boolean
  timeZone: string
  /** 状态文件路径；null = 不持久化（测试用）。 */
  statePath: string | null
}

export interface MailDigestState {
  lastDate: string | null
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 的整数（当前 ${JSON.stringify(raw)}）`)
  }
  return value
}

/**
 * 解析调度配置。`AT` 未设 / 空 / `off` / `0` → null（关闭）。
 * 其余字段非法一律抛错：静默回落会让「以为配了」变成「其实没开」。
 */
export function parseDigestEnv(
  env: NodeJS.ProcessEnv,
  defaults: { statePath?: string } = {},
): MailDigestConfig | null {
  const rawAt = env.DSH_WFXM_MAIL_DIGEST_AT?.trim()
  if (rawAt === undefined || rawAt === '' || rawAt === '0' || rawAt.toLowerCase() === 'off') {
    return null
  }
  const match = AT_RE.exec(rawAt)
  if (match === null) {
    throw new Error(`DSH_WFXM_MAIL_DIGEST_AT 必须是 HH:MM（当前 ${JSON.stringify(rawAt)}）`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new Error(`DSH_WFXM_MAIL_DIGEST_AT 超出范围（当前 ${JSON.stringify(rawAt)}）`)
  }

  const timeZone = env.DSH_WFXM_MAIL_DIGEST_TZ?.trim() || DEFAULT_DIGEST_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone })
  } catch {
    throw new Error(`DSH_WFXM_MAIL_DIGEST_TZ 不是有效时区（当前 ${JSON.stringify(timeZone)}）`)
  }

  const rawUnread = env.DSH_WFXM_MAIL_DIGEST_UNREAD?.trim().toLowerCase()
  const rawState = env.DSH_WFXM_MAIL_DIGEST_STATE?.trim()
  const rawChat = env.DSH_WFXM_MAIL_DIGEST_CHAT_ID?.trim()

  return {
    at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    channelId: env.DSH_WFXM_MAIL_DIGEST_CHANNEL?.trim() || 'feishu',
    chatId: rawChat === undefined || rawChat === '' ? null : rawChat,
    hours: readInt(env, 'DSH_WFXM_MAIL_DIGEST_HOURS', 24, 1, 168),
    limit: readInt(env, 'DSH_WFXM_MAIL_DIGEST_LIMIT', 20, 1, 50),
    unreadOnly: !(rawUnread === '0' || rawUnread === 'false' || rawUnread === 'off'),
    timeZone,
    statePath: rawState === undefined || rawState === '' ? defaults.statePath ?? null : rawState,
  }
}

/** 显式时区的本地日期与当日分钟数；不读进程 TZ。 */
export function localDayMinutes(
  now: Date,
  timeZone: string = DEFAULT_DIGEST_TIME_ZONE,
): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  // 部分 ICU 在午夜给出 `24`，按 0 点处理。
  const hour = Number(get('hour')) % 24
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  }
}

/**
 * 到点且今天未发。用 `>=` 而不是 `===`：08:30 时进程不在，重启后当天补发。
 */
export function digestDue(input: {
  now: Date
  at: string
  lastDate: string | null
  timeZone: string
}): boolean {
  const match = AT_RE.exec(input.at)
  if (match === null) return false
  const atMinutes = Number(match[1]) * 60 + Number(match[2])
  const local = localDayMinutes(input.now, input.timeZone)
  return local.minutes >= atMinutes && local.date !== input.lastDate
}

/** 缺失 / 损坏 / 字段非日期 → null；调度会据此重发，不会永久卡死。 */
export function readDigestState(path: string | null): MailDigestState {
  if (path === null) return { lastDate: null }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { lastDate: null }
  }
  try {
    const parsed = JSON.parse(raw) as { lastDate?: unknown }
    const lastDate = parsed?.lastDate
    return { lastDate: typeof lastDate === 'string' && DATE_RE.test(lastDate) ? lastDate : null }
  } catch {
    return { lastDate: null }
  }
}

/** 原子写：先写 `.tmp` 再 rename，进程中断不会留下半个 JSON。 */
export function writeDigestState(
  path: string | null,
  state: { lastDate: string; firedAt: string },
): void {
  if (path === null) return
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o640 })
  renameSync(tmp, path)
}
