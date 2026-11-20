/**
 * B2 收口：项目注册时的自动检测（Slice BR）。
 *
 * 只做**只读推断**，不执行任何命令：
 *   - `prepareCmd`：按仓库里已有的锁文件/构建清单推断安装命令；
 *   - `rulesDoc`：按约定优先级找仓库内的规则/说明文档。
 *
 * 显式参数永远优先；推断不出来返回 null，由 owner 后续补。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 顺序即优先级：同一仓库有多个锁文件时取最具体的一个。 */
const PREPARE_BY_MARKER = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['Cargo.toml', 'cargo fetch'],
  ['go.mod', 'go mod download'],
]

/** 规则文档优先级：越靠前越"专门给 agent 看"。 */
const RULES_DOC_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'README.rst',
  'CONTRIBUTING.md',
]

export function detectPrepareCmd(root) {
  for (const [marker, command] of PREPARE_BY_MARKER) {
    if (existsSync(join(root, marker))) return command
  }
  return null
}

export function detectRulesDoc(root) {
  for (const candidate of RULES_DOC_CANDIDATES) {
    if (existsSync(join(root, candidate))) return candidate
  }
  return null
}
