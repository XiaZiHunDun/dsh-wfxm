/**
 * `/eval` 的只读快照与文案（P2-1）。
 *
 * 生产没有 agent-eval：`eval/latest.json` 随发布生成，这里只读、不执行测评。
 * 快照缺失或损坏都必须明说，绝不伪造"通过"。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface EvalSuiteSummary {
  name: string
  passed: number
  total: number
  rate: number
}

export interface EvalRealSummary {
  passed: number
  total: number
  rate: number
  recordedAt?: string
  failures?: Array<{ taskId: string; rate: number }>
}

export interface EvalSnapshot {
  version: number
  recordedAt: string
  source: string
  advisory?: boolean
  gate?: {
    ok: boolean
    advisory?: boolean
    suites: EvalSuiteSummary[]
  } | null
  real?: Record<string, EvalRealSummary> | null
  failures?: Array<{ suite: string; taskId?: string; rate?: number }>
}

export type EvalSnapshotLoad =
  | { ok: true; snapshot: EvalSnapshot }
  | { ok: false; reason: 'missing' | 'invalid'; detail?: string }

/** 默认 `eval/latest.json`：`plugins/host/{src,lib}` 上溯三级即仓库根。 */
export function defaultEvalSnapshotPath(): string {
  return fileURLToPath(new URL('../../../eval/latest.json', import.meta.url))
}

export function loadEvalSnapshot(file: string): EvalSnapshotLoad {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid', detail: '顶层不是对象' }
    }
    const snapshot = parsed as EvalSnapshot
    if (typeof snapshot.recordedAt !== 'string') {
      return { ok: false, reason: 'invalid', detail: '缺少 recordedAt' }
    }
    return { ok: true, snapshot }
  } catch (error) {
    return { ok: false, reason: 'invalid', detail: error instanceof Error ? error.message : String(error) }
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function suiteLine(suite: EvalSuiteSummary): string {
  return `${suite.name} ${suite.passed}/${suite.total}`
}

export function formatEvalStatus(load: EvalSnapshotLoad): string {
  if (!load.ok) {
    return load.reason === 'missing'
      ? '暂无测评快照（发布时未生成 eval/latest.json）；可先查看 CI/nightly 报告。'
      : `测评快照损坏（${load.detail ?? '未知原因'}）；不做任何通过推断。`
  }
  const snapshot = load.snapshot
  const lines: string[] = [`测评结果（${snapshot.advisory === true ? 'advisory' : snapshot.gate?.advisory === true ? 'advisory' : '快照'}）`]

  if (snapshot.gate !== undefined && snapshot.gate !== null) {
    const suites = snapshot.gate.suites ?? []
    const passedSuites = suites.filter((suite) => suite.total > 0 && suite.passed === suite.total).length
    lines.push(
      `离线 L2：${passedSuites}/${suites.length} 套件通过${suites.length === 0 ? '' : `（${suites.map(suiteLine).join(' · ')}）`}`,
    )
  } else {
    lines.push('离线 L2：快照未包含（未运行门禁）')
  }

  const real = snapshot.real ?? {}
  const realNames = Object.keys(real)
  if (realNames.length > 0) {
    lines.push(
      `真实基线：${realNames.map((name) => {
        const item = real[name]
        return `${name} ${item.passed}/${item.total}（${pct(item.rate)}）`
      }).join(' · ')}`,
    )
  } else {
    lines.push('真实基线：快照未包含')
  }

  const failures = snapshot.failures ?? []
  if (failures.length > 0) {
    const labels = failures.slice(0, 3).map((item) => item.taskId === undefined
      ? `${item.suite}（套件未全过）`
      : `${item.taskId}（${item.suite}）`)
    lines.push(`失败 ${failures.length} 项：${labels.join('、')}${failures.length > labels.length ? ' 等' : ''}`)
  } else {
    lines.push('失败：无')
  }

  lines.push(`快照：${snapshot.recordedAt}（${snapshot.source}）`)
  return lines.join('\n')
}

export function formatEvalFindings(load: EvalSnapshotLoad): string {
  if (!load.ok) {
    return load.reason === 'missing'
      ? '暂无测评快照，无法列出失败项。'
      : `测评快照损坏（${load.detail ?? '未知原因'}），无法列出失败项。`
  }
  const failures = load.snapshot.failures ?? []
  if (failures.length === 0) return '没有未通过项。'
  return [
    `未通过 ${failures.length} 项：`,
    ...failures.slice(0, 20).map((item) => {
      const rate = typeof item.rate === 'number' ? `（${pct(item.rate)}）` : ''
      const label = item.taskId ?? `${item.suite}（套件未全过）`
      return item.taskId === undefined
        ? `- ${label}${rate}`
        : `- ${label} · ${item.suite}${rate}`
    }),
    ...(failures.length > 20 ? ['（仅显示前 20 项）'] : []),
  ].join('\n')
}

export function formatEvalHelp(): string {
  return [
    '/eval — 最近一次测评摘要',
    '/eval findings — 列出未处理失败项（带 finding 短 id）',
    '/eval flag <原因> — 引用一条消息，人工标记为 finding',
    '/eval promote <id> — 生成候选任务到 eval/candidates/（需 AGENT_EVAL_ROOT）',
    '/eval from-task <任务号> — 把一条失败任务的脱敏轨迹回流成候选',
    '/eval ignore <id> — 关闭 finding',
    '/eval run l2 — 开发机跑离线五套件（需 AGENT_EVAL_ROOT）',
    '/eval run real — 真实套件只在 CI/nightly 执行',
    '/eval help — 本说明',
    '仅 owner 可用；/eval run 每 5 分钟最多一次。',
  ].join('\n')
}

export function formatEvalUnsupported(detail: string): string {
  return `${detail}\n\n${formatEvalHelp()}`
}
