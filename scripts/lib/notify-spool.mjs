/**
 * 跨用户通知队列（P7-5）：发布门禁失败 → owner 飞书。
 *
 * 权限边界决定了不能让 `release.mjs` 直接发飞书：
 * - `release prepare` 以发布用户（ailearn）运行，读不到 `/etc/dsh-wfxm/env`
 *   里的飞书凭据，也不能写 0600 的 `ops.sqlite`；
 * - `scripts/health-alert.mjs` 以服务用户（dshwfxm）运行，凭据与 chat 都在它这边。
 *
 * 所以两者用发布根目录下的 `notify/` 交接：发布方落一个 0644 JSON，
 * 健康定时器（2 分钟一次）取走并发送，成功后把文件名记进数据目录的状态文件。
 * 发布方只写自己的目录，不接触服务数据；通知失败也绝不反向影响发布结论。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export function notifyDir(root) {
  return join(root, 'notify')
}

/**
 * 落一条待发通知，返回文件路径；任何失败返回 null（调用方只告警）。
 * 文件名按 UTC 时间戳排序，消费端按名字顺序发送。
 */
export function writeNotification({ dir, text, kind = 'gate', now = new Date() }) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    // 发布用户与服务用户的 umask 可能不同（0077 会让目录变成 0700）。
    chmodSync(dir, 0o755)
    const stamp = now.toISOString().replace(/[-:.]/g, '')
    const target = join(dir, `${stamp}-${process.pid}-${kind}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ kind, createdAt: now.toISOString(), text }, null, 2)}\n`)
    chmodSync(tmp, 0o644)
    renameSync(tmp, target)
    return target
  } catch {
    return null
  }
}

export function readNotifyState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const handled = Array.isArray(parsed?.handled)
      ? parsed.handled.filter((name) => typeof name === 'string')
      : []
    return { handled }
  } catch {
    return { handled: [] }
  }
}

function writeNotifyState(path, handled) {
  writeFileSync(path, `${JSON.stringify({ handled }, null, 2)}\n`, { mode: 0o600 })
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把 spool 里未处理的通知发给 owner。
 *
 * - 已记录的、已不存在的文件名都会从状态里清掉；
 * - 坏 JSON / 空正文直接标记，避免每轮重复报同一个错；
 * - 发送失败**不标记**，下一轮（2 分钟后）重试；
 * - 没有 chat 时什么都不做，等 chat 出现后自然补发。
 */
export async function drainNotifications({ dir, statePath, loadChatId, send, limit = 5 }) {
  if (!existsSync(dir)) return { status: 'empty', sent: 0 }
  const names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  if (names.length === 0) return { status: 'empty', sent: 0 }

  const state = readNotifyState(statePath)
  const handled = new Set(state.handled.filter((name) => names.includes(name)))
  const pending = names.filter((name) => !handled.has(name)).slice(0, limit)
  if (pending.length === 0) {
    if (handled.size !== state.handled.length) writeNotifyState(statePath, [...handled])
    return { status: 'up-to-date', sent: 0 }
  }

  const chatId = loadChatId()
  if (chatId === null) return { status: 'no-chat', sent: 0 }

  let sent = 0
  for (const name of pending) {
    const item = readJson(join(dir, name))
    if (item === null || typeof item.text !== 'string' || item.text.trim() === '') {
      handled.add(name)
      continue
    }
    try {
      await send(item.text, chatId)
    } catch (error) {
      writeNotifyState(statePath, [...handled])
      return {
        status: 'send-failed',
        sent,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    handled.add(name)
    sent += 1
  }
  writeNotifyState(statePath, [...handled])
  return { status: sent > 0 ? 'sent' : 'up-to-date', sent }
}
