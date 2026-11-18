#!/usr/bin/env node
/**
 * Out-of-process health alert (docs/16 §12.29).
 *
 * The service itself cannot report its own death, so a systemd timer runs this
 * script: if `dsh-wfxm` is not active it sends one Feishu message to the owner's
 * chat, then stays quiet for a cooldown so a crash loop does not spam.
 *
 * Exported pieces are dependency-injected so the unit test never touches
 * systemd, Feishu, or the production DB.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_COOLDOWN_MS = 30 * 60_000
export const DEFAULT_STATE_PATH = '/var/lib/dsh-wfxm/health-alert.state'
const UNIT = 'dsh-wfxm'

export function buildText(state, target = hostname(), now = new Date()) {
  return [
    `[服务告警] ${UNIT} 当前状态：${state}（${target}）`,
    `时间：${now.toISOString()}`,
    `请检查：journalctl -u ${UNIT} -n 50 --no-pager`,
  ].join('\n')
}

/**
 * Send only when the service is unhealthy, and at most once per cooldown for
 * the same state. A different failure state (e.g. failed → inactive) notifies
 * immediately: it is new information.
 */
export function shouldSend(previous, nowMs, cooldownMs = DEFAULT_COOLDOWN_MS) {
  if (previous === null) return true
  const last = typeof previous.sentAtMs === 'number' ? previous.sentAtMs : 0
  return nowMs - last >= cooldownMs
}

export function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function writeState(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** Last chat the service talked to; `threads` is the most stable source. */
export function readChatId(dbPath) {
  if (!existsSync(dbPath)) return null
  try {
    // Imported lazily: the unit test does not need node:sqlite.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT chat_id FROM threads ORDER BY rowid DESC LIMIT 1').get()
      return typeof row?.chat_id === 'string' && row.chat_id !== '' ? row.chat_id : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function runHealthAlert(deps) {
  const nowMs = deps.nowMs ?? Date.now()
  const state = deps.checkService()
  if (state === 'active') return { status: 'healthy', sent: false }

  const previous = readState(deps.statePath)
  const sameState = previous !== null && previous.state === state
  if (sameState && !shouldSend(previous, nowMs, deps.cooldownMs)) {
    return { status: 'cooldown', sent: false }
  }

  const chatId = deps.loadChatId()
  if (chatId === null) return { status: 'no-chat', sent: false }

  await deps.send(buildText(state, deps.target, new Date(nowMs)), chatId)
  writeState(deps.statePath, { state, sentAtMs: nowMs })
  return { status: 'sent', sent: true }
}

function systemctlIsActive() {
  const run = spawnSync('systemctl', ['is-active', UNIT], { encoding: 'utf8' })
  const value = (run.stdout ?? '').trim()
  return value === '' ? 'unknown' : value
}

async function sendFeishu(text, chatId, env = process.env) {
  const release = env.DSH_WFXM_RELEASE ?? '/opt/dsh-wfxm/current'
  const { loadFeishuCredentials } = await import(join(release, 'plugins/feishu/lib/credentials.js'))
  // Production keeps credentials outside $HOME (ProtectHome=yes); the main
  // service gets the same two paths via /etc/dsh-wfxm/env.
  const credentials = loadFeishuCredentials({
    ...env.DSH_WFXM_FEISHU_CONFIG === undefined ? {} : { configPath: env.DSH_WFXM_FEISHU_CONFIG },
    ...env.DSH_WFXM_CREDENTIALS === undefined ? {} : { credentialsPath: env.DSH_WFXM_CREDENTIALS },
  })
  const base = env.DSH_WFXM_FEISHU_BASE
    ?? (credentials.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn')

  const tokenResponse = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
  })
  const tokenBody = await tokenResponse.json()
  if (!tokenResponse.ok || typeof tokenBody?.tenant_access_token !== 'string') {
    throw new Error(`tenant_access_token failed: ${tokenResponse.status}`)
  }

  const messageResponse = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokenBody.tenant_access_token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })
  if (!messageResponse.ok) throw new Error(`send failed: ${messageResponse.status}`)
}

async function main() {
  const dataDir = process.env.DSH_WFXM_DATA_DIR ?? '/var/lib/dsh-wfxm'
  const cooldownMinutes = Number(process.env.DSH_WFXM_HEALTH_ALERT_MINUTES ?? '30')
  const result = await runHealthAlert({
    checkService: systemctlIsActive,
    statePath: process.env.DSH_WFXM_HEALTH_STATE ?? DEFAULT_STATE_PATH,
    cooldownMs: Number.isFinite(cooldownMinutes) ? cooldownMinutes * 60_000 : DEFAULT_COOLDOWN_MS,
    target: hostname(),
    loadChatId: () => process.env.DSH_WFXM_HEALTH_CHAT_ID ?? readChatId(join(dataDir, 'ops.sqlite')),
    send: (text, chatId) => sendFeishu(text, chatId),
  })
  console.log(`health-alert: ${result.status}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`health-alert failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
