/**
 * Feishu bot credential resolution.
 *
 * Bot config lives in `~/.dsh/integrations/dsh-feishu/config.json` (dsh-im
 * keeps the bot registry there); the secret is a `secretRef` into dsh's
 * credential store `~/.dsh/.credentials.yaml` (`refs:` map). This module only
 * *reads* both files; it never logs or returns anything beyond the resolved
 * pair to the caller.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface FeishuBotConfig {
  readonly id: string
  readonly appId: string
  readonly secretRef: string
  readonly domain: string | null
  readonly botOpenId: string | null
}

export interface FeishuCredentials {
  readonly appId: string
  readonly appSecret: string
  readonly domain: string | null
  readonly botOpenId: string | null
}

export const DEFAULT_FEISHU_CONFIG_PATH = join(homedir(), '.dsh/integrations/dsh-feishu/config.json')
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.dsh/.credentials.yaml')

function fail(message: string): never {
  throw new Error(`feishu credentials: ${message}`)
}

export function loadFeishuBotConfig(options?: {
  configPath?: string
  /** Select one bot when several are configured; defaults to the first. */
  appId?: string
}): FeishuBotConfig {
  const configPath = options?.configPath ?? DEFAULT_FEISHU_CONFIG_PATH
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    fail(`cannot read bot config ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const bots = (parsed as { bots?: unknown }).bots
  if (!Array.isArray(bots) || bots.length === 0) fail(`no bots configured in ${configPath}`)
  const match = options?.appId === undefined
    ? bots[0]
    : bots.find((bot) => (bot as { appId?: unknown }).appId === options.appId)
  if (match === undefined || match === null) {
    fail(`no bot with appId ${options?.appId ?? ''} in ${configPath}`)
  }
  const bot = match as Record<string, unknown>
  if (typeof bot.appId !== 'string' || bot.appId === '') fail('bot entry has no appId')
  if (typeof bot.secretRef !== 'string' || bot.secretRef === '') fail('bot entry has no secretRef')
  return {
    id: typeof bot.id === 'string' ? bot.id : bot.appId,
    appId: bot.appId,
    secretRef: bot.secretRef,
    domain: typeof bot.domain === 'string' && bot.domain !== '' ? bot.domain : null,
    botOpenId: typeof bot.botOpenId === 'string' && bot.botOpenId !== '' ? bot.botOpenId : null,
  }
}

/**
 * Read one secret out of the dsh credential store's flat `refs:` map. The file
 * is simple enough (`refs:` + indented `KEY: value` lines) that a YAML
 * dependency is unwarranted; anything unexpected fails loudly.
 */
export function resolveSecretRef(secretRef: string, options?: { credentialsPath?: string }): string {
  const credentialsPath = options?.credentialsPath ?? DEFAULT_CREDENTIALS_PATH
  let text: string
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    fail(`cannot read credential store ${credentialsPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const lines = text.split('\n')
  let inRefs = false
  let refsIndent = -1
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (!inRefs) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        refsIndent = indent
      }
      continue
    }
    if (indent <= refsIndent) break // left the refs map
    const match = /^(\S+):\s*(.*)$/.exec(line.trimStart())
    if (match === null) continue
    if (match[1] === secretRef) {
      const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
      if (value === '') fail(`secretRef ${secretRef} is empty in ${credentialsPath}`)
      return value
    }
  }
  fail(`secretRef ${secretRef} not found in ${credentialsPath}`)
}

export function loadFeishuCredentials(options?: {
  configPath?: string
  credentialsPath?: string
  appId?: string
}): FeishuCredentials {
  const bot = loadFeishuBotConfig(options)
  const appSecret = resolveSecretRef(bot.secretRef, {
    ...(options?.credentialsPath === undefined ? {} : { credentialsPath: options.credentialsPath }),
  })
  return { appId: bot.appId, appSecret, domain: bot.domain, botOpenId: bot.botOpenId }
}
