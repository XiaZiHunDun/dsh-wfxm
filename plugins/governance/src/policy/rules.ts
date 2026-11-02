import { existsSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Policy } from './config.js'

export interface PolicyVerdict {
  verdict: 'allow' | 'deny'
  rule: string
  reason?: string
}

const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const READ_TOOLS = new Set(['read'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

function isUnder(root: string, target: string): boolean {
  const path = resolve(target)
  return path === root || path.startsWith(root + sep)
}

function pathArgument(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function commandArgument(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const value = (args as Record<string, unknown>).command
  return typeof value === 'string' ? value : null
}

function rmTargetsOutside(command: string, roots: readonly string[]): boolean {
  const matches = command.matchAll(/\brm\b([^\n;|&]*)/g)
  for (const match of matches) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      const candidate = token.replace(/^['"]|['"]$/g, '')
      if (!candidate.startsWith('/')) continue
      if (!roots.some((root) => isUnder(root, candidate))) return true
    }
  }
  return false
}

/**
 * Evaluate one tool call. Unknown tools are allowed: gating is deliberately
 * narrow (path boundary + shell denylist) rather than a full allowlist, so
 * adding a host tool does not require touching the policy.
 */
export function evaluate(policy: Policy, toolName: string, args: unknown): PolicyVerdict {
  if (existsSync(policy.killSwitchPath)) {
    return { verdict: 'deny', rule: 'kill-switch', reason: '全局 kill switch 已启用' }
  }

  if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
    const target = pathArgument(args)
    // Relative paths stay inside the session workspace, which the host
    // sandbox already bounds; only absolute paths can escape it.
    if (target !== null && isAbsolute(target)) {
      const roots = WRITE_TOOLS.has(toolName) ? policy.writeRoots : policy.readRoots
      const allowed = roots.some((root) => isUnder(root, target))
      if (!allowed) {
        return {
          verdict: 'deny',
          rule: WRITE_TOOLS.has(toolName) ? 'write-root' : 'read-root',
          reason: `${toolName} 目标不在允许根内：${target}`,
        }
      }
    }
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = commandArgument(args)
    if (command !== null) {
      for (const pattern of policy.bash.denyPatterns) {
        if (new RegExp(pattern).test(command)) {
          return { verdict: 'deny', rule: 'bash-deny', reason: `命令命中禁用规则：${pattern}` }
        }
      }
      if (rmTargetsOutside(command, policy.writeRoots)) {
        return { verdict: 'deny', rule: 'bash-rm-outside', reason: 'rm 目标在允许写根之外' }
      }
    }
  }

  return { verdict: 'allow', rule: 'default' }
}
