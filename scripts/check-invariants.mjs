#!/usr/bin/env node
/**
 * Executable invariants (A4 / D19-1 阶段 2).
 *
 * AR32 — the port layer carries no protocol, command or product names.
 * AR33 — modules only talk through API or events; no module imports another
 *        module's tables / store / schema / migrations directly.
 *
 * Usage:
 *   node scripts/check-invariants.mjs [root]
 *
 * Exits 1 with one line per violation; exits 0 when clean (including the case
 * where `ports/` does not exist yet).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CODE = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', '.git', 'coverage'])

/** AR32: adapter-specific words that must never appear under `ports/`. */
const PORT_TOKENS = [
  // commands
  'systemctl',
  'journalctl',
  'systemd-run',
  'docker',
  'podman',
  'kubectl',
  'df',
  'ss',
  // protocols / products
  'ntfy',
  'feishu',
  'lark',
  'wechat',
  'weixin',
  'smtp',
  'imap',
  'caldav',
  'sqlite',
  'playwright',
  '飞书',
  '微信',
]

const TOKEN_PATTERNS = PORT_TOKENS.map((token) => ({
  token,
  pattern: /^[\x00-\x7F]+$/.test(token)
    ? new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    : new RegExp(token),
}))

/** AR33: file-name segments that mean "someone is reaching into another module's data". */
const DATA_SEGMENTS = /(?:^|\/)(?:store|tables?|db|schema|migrations?)(?:\/|\.|$)/i

const IMPORT_SPEC =
  /(?:^\s*(?:import|export)\b[^'"]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (CODE.test(entry.name)) out.push(full)
  }
  return out
}

function lines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/)
}

function rel(root, file) {
  return relative(root, file).split(sep)
}

/** AR32 — every file whose path contains a `ports` segment. */
export function checkPortIsolation(root) {
  const findings = []
  for (const file of walk(root)) {
    const segments = rel(root, file)
    if (!segments.includes('ports')) continue
    for (const [index, text] of lines(file).entries()) {
      for (const { token, pattern } of TOKEN_PATTERNS) {
        if (pattern.test(text)) {
          findings.push({
            rule: 'AR32',
            file: relative(root, file),
            line: index + 1,
            detail: `端口层出现 "${token}"`,
          })
        }
      }
    }
  }
  return findings
}

function pluginModule(root, file) {
  const segments = rel(root, file)
  if (segments[0] !== 'plugins' || segments.length < 3) return undefined
  return segments[1]
}

/** AR33 — no cross-package relative import, no deep import into another module's data files. */
export function checkCrossModuleImports(root) {
  const findings = []
  for (const file of walk(join(root, 'plugins'))) {
    const mod = pluginModule(root, file)
    if (mod === undefined) continue
    const pkgDir = join(root, 'plugins', mod)
    for (const [index, text] of lines(file).entries()) {
      for (const match of text.matchAll(IMPORT_SPEC)) {
        const spec = match[1]
        const line = index + 1

        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec)
          if (relative(pkgDir, target).startsWith('..')) {
            findings.push({
              rule: 'AR33',
              file: relative(root, file),
              line,
              detail: `跨模块相对导入 "${spec}"（只许经 API 或事件）`,
            })
          }
          continue
        }

        const workspace = /^@dsh-wfxm\/([^/]+)(\/.*)?$/.exec(spec)
        if (workspace === null) continue
        const [, other, subpath = ''] = workspace
        if (other === mod) continue
        if (DATA_SEGMENTS.test(subpath)) {
          findings.push({
            rule: 'AR33',
            file: relative(root, file),
            line,
            detail: `直读 @dsh-wfxm/${other} 的数据文件 "${spec}"`,
          })
        }
      }
    }
  }
  return findings
}

export function runChecks(root) {
  const findings = [...checkPortIsolation(root), ...checkCrossModuleImports(root)]
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { ok: findings.length === 0, findings }
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd())
  const { ok, findings } = runChecks(root)
  if (ok) {
    console.log('invariants: OK (AR32/AR33)')
    return 0
  }
  for (const item of findings) {
    console.error(`${item.rule}  ${item.file}:${item.line}  ${item.detail}`)
  }
  console.error(`invariants: ${findings.length} violation(s)`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}

export const __dirname = dirname(fileURLToPath(import.meta.url))
