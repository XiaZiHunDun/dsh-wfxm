/**
 * G4 v1 (docs/20 §三 Slice CD): daily suggestions derived from state that is
 * already collected. Rules come first — no model call — and the output is
 * advisory only: nothing here creates or modifies a task.
 */

import { CANDIDATE_RULES, type CandidateInput } from './inspection/candidates.js'
import { DEFAULT_EXPERT_THRESHOLDS, evaluateExpertHealth } from './routing.js'
import type { ExpertOutcome, ExpertThresholds } from './routing.js'

export interface FailureBreakdown {
  /** `attempt >= maxAttempts` at terminal failure. */
  retryExhausted: number
  /** Terminal failure that was not retryable (judgement / policy / input). */
  nonRetryable: number
  /** Tasks whose merge state is `conflict`. */
  conflicts: number
}

export interface SuggestionBudget {
  tokens: number
  limit: number
}

/** P7-6: 近 7 天轨迹指标（由遥测侧聚合，这里只做阈值判断）。 */
export interface TraceHealth {
  attempts: number
  failedAttempts: number
  p95Ms: number | null
}

export interface TraceHealthThresholds {
  /** 失败率阈值（0-1）；0 关闭该条规则。 */
  failRate: number
  /** p95 时延阈值（毫秒）；0 关闭该条规则。 */
  p95Ms: number
  /** 少于该样本数时指标视为噪声，两条规则都不触发。 */
  minAttempts: number
}

export const DEFAULT_TRACE_HEALTH_THRESHOLDS: TraceHealthThresholds = {
  failRate: 0.3,
  p95Ms: 300_000,
  minAttempts: 10,
}

export type TraceBreachKind = 'fail-rate' | 'p95'

export interface TraceBreach {
  kind: TraceBreachKind
  reason: string
}

export interface SuggestionInput {
  candidates: CandidateInput[]
  failures: FailureBreakdown
  /** Facts flagged by `mem_health` as review candidates (>30 days unused). */
  reviewFacts: number
  budget?: SuggestionBudget | null
  /** P7-6：轨迹指标越过阈值时追加建议；`null`/缺省时不改变现有规则。 */
  trace?: { health: TraceHealth; thresholds?: TraceHealthThresholds } | null
  /** G8：专家失败率越线时追加建议；`null`/缺省时不改变现有规则。 */
  routing?: { experts: readonly ExpertOutcome[]; thresholds?: ExpertThresholds } | null
  max?: number
}

export interface Suggestion {
  action: string
  evidence: string
  risk: 'R1' | 'R2'
}

const RULE_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(CANDIDATE_RULES).map((rule) => [rule.ruleId, rule.title]),
)

const TRACE_ACTIONS: Readonly<Record<TraceBreachKind, string>> = {
  'fail-rate': '排查近期执行失败率偏高，决定是否回退或补充失败说明',
  p95: '排查近期执行 p95 偏高，定位慢步骤（执行器/工具）',
}

function formatMs(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}

/**
 * P7-6：阈值判断只在这里实现一次，日报建议与即时告警共用同一组原因。
 * 样本不足（`minAttempts`）时不报，避免一两条长任务就触发告警。
 */
export function evaluateTraceHealth(
  trace: TraceHealth,
  thresholds: TraceHealthThresholds = DEFAULT_TRACE_HEALTH_THRESHOLDS,
): TraceBreach[] {
  if (trace.attempts < thresholds.minAttempts) return []
  const breaches: TraceBreach[] = []
  if (thresholds.failRate > 0) {
    const rate = trace.failedAttempts / trace.attempts
    if (rate >= thresholds.failRate) {
      breaches.push({
        kind: 'fail-rate',
        reason: `失败 ${trace.failedAttempts}/${trace.attempts}（${Math.round(rate * 100)}%）`
          + ` ≥ 阈值 ${Math.round(thresholds.failRate * 100)}%`,
      })
    }
  }
  if (thresholds.p95Ms > 0 && trace.p95Ms !== null && trace.p95Ms >= thresholds.p95Ms) {
    breaches.push({
      kind: 'p95',
      reason: `p95 ${formatMs(trace.p95Ms)} ≥ 阈值 ${formatMs(thresholds.p95Ms)}`,
    })
  }
  return breaches
}

/**
 * `DSH_WFXM_TRACE_FAIL_RATE_PCT` / `DSH_WFXM_TRACE_P95_MS` /
 * `DSH_WFXM_TRACE_MIN_ATTEMPTS`；非法值保留默认并给出警告。
 */
export function readTraceHealthConfig(env: NodeJS.ProcessEnv = process.env): {
  thresholds: TraceHealthThresholds
  warnings: string[]
} {
  const warnings: string[] = []
  const read = (raw: string | undefined, field: string, min: number, max: number, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) {
      warnings.push(`${field}=${JSON.stringify(raw)} is not an integer in ${min}-${max}; using ${fallback}`)
      return fallback
    }
    return value
  }
  const failRatePct = read(env.DSH_WFXM_TRACE_FAIL_RATE_PCT, 'DSH_WFXM_TRACE_FAIL_RATE_PCT', 0, 100, 30)
  const p95Ms = read(env.DSH_WFXM_TRACE_P95_MS, 'DSH_WFXM_TRACE_P95_MS', 0, 86_400_000, 300_000)
  const minAttempts = read(env.DSH_WFXM_TRACE_MIN_ATTEMPTS, 'DSH_WFXM_TRACE_MIN_ATTEMPTS', 1, 10_000, 10)
  return { thresholds: { failRate: failRatePct / 100, p95Ms, minAttempts }, warnings }
}

/**
 * Deterministic order: data integrity first, then repeated failure, cost,
 * traces crossing the P7-6 thresholds, and finally observations. `max` caps
 * the list (default 3).
 */
export function deriveSuggestions(input: SuggestionInput): Suggestion[] {
  const max = input.max ?? 3
  const suggestions: Suggestion[] = []

  if (input.failures.conflicts > 0) {
    suggestions.push({
      action: `处理 ${input.failures.conflicts} 个合并冲突任务`,
      evidence: '任务 merge_state=conflict',
      risk: 'R2',
    })
  }
  if (input.failures.retryExhausted >= 2) {
    suggestions.push({
      action: '排查近期重试耗尽的任务，决定是否调整执行器或判据',
      evidence: `近 7 天重试耗尽 ${input.failures.retryExhausted} 个`,
      risk: 'R1',
    })
  }
  if (input.failures.nonRetryable >= 2) {
    suggestions.push({
      action: '复核近期不可重试失败（权限/输入/判据），必要时补充失败说明',
      evidence: `近 7 天不可重试失败 ${input.failures.nonRetryable} 个`,
      risk: 'R1',
    })
  }
  const budget = input.budget
  if (budget !== null && budget !== undefined && budget.limit > 0) {
    const ratio = budget.tokens / budget.limit
    if (ratio >= 0.8) {
      suggestions.push({
        action: `今日 token 已用 ${Math.round(ratio * 100)}%，收紧任务或调高每日上限`,
        evidence: `预算 ${budget.tokens}/${budget.limit}`,
        risk: 'R1',
      })
    }
  }

  if (input.trace !== null && input.trace !== undefined) {
    for (const breach of evaluateTraceHealth(input.trace.health, input.trace.thresholds)) {
      suggestions.push({
        action: TRACE_ACTIONS[breach.kind],
        evidence: breach.reason,
        risk: 'R1',
      })
    }
  }

  if (input.routing !== null && input.routing !== undefined) {
    for (const breach of evaluateExpertHealth(
      input.routing.experts,
      input.routing.thresholds ?? DEFAULT_EXPERT_THRESHOLDS,
    )) {
      suggestions.push({
        action: `排查专家 ${breach.expert ?? '未指派'} 近 7 天失败率偏高，决定继续路由或调整分工`,
        evidence: breach.reason,
        risk: 'R1',
      })
    }
  }

  const ordered = [...input.candidates].sort((left, right) => {
    const rank = (status: CandidateInput['status']): number => (status === 'fail' ? 0 : 1)
    return rank(left.status) - rank(right.status)
  })
  for (const candidate of ordered) {
    if (suggestions.length >= max) break
    suggestions.push({
      action: `处理巡检候选：${RULE_TITLES[candidate.ruleId] ?? candidate.ruleId}`,
      evidence: `${candidate.target} · ${candidate.itemId}=${candidate.observed}`,
      risk: 'R1',
    })
  }

  if (input.reviewFacts > 0 && suggestions.length < max) {
    suggestions.push({
      action: '复核长期未引用的事实，过时则取代或删除',
      evidence: `事实体检复核候选 ${input.reviewFacts} 条`,
      risk: 'R1',
    })
  }

  return suggestions.slice(0, max)
}

/** 落库后的建议（tasks 模块返回的结构与本类型兼容）。 */
export interface SuggestionEntry extends Suggestion {
  id: string
  ordinal: number
}

/** Renders the digest block; `null` when there is nothing to suggest. */
export function formatSuggestions(suggestions: Suggestion[]): string | null {
  if (suggestions.length === 0) return null
  const lines = ['建议：']
  suggestions.forEach((suggestion, index) => {
    lines.push(`${index + 1}. [${suggestion.risk}] ${suggestion.action}（依据：${suggestion.evidence}）`)
  })
  lines.push('回复「做 #n」按正常审批流程发起，不会自动执行。')
  return lines.join('\n')
}

/**
 * P7-3: 带稳定 id 的日报建议块。
 *
 * 序号仍然从 1 开始方便回复「做 #1」，同时给出可跨天引用的 `#sug_*`。
 */
export function formatSuggestionDigest(entries: readonly SuggestionEntry[]): string | null {
  if (entries.length === 0) return null
  const lines = ['建议：']
  for (const entry of entries) {
    lines.push(
      `${entry.ordinal}. [${entry.risk}] ${entry.action}（依据：${entry.evidence}） · 做 #${entry.id}`,
    )
  }
  lines.push('回复「做 #1」或「做 #sug_xxxxxxxx」按正常审批流程发起；「忽略 #1」记录为已忽略，不会自动执行。')
  return lines.join('\n')
}

/** 周报用的建议采纳统计（tasks `countSuggestions` 的返回结构与本类型兼容）。 */
export interface SuggestionStats {
  total: number
  accepted: number
  ignored: number
  pending: number
}

/** §六 第 3 条：近 7 天建议的采纳率；没有建议时整段省略。 */
export function formatSuggestionWeekly(stats: SuggestionStats | null): string | null {
  if (stats === null || stats.total === 0) return null
  const rate = Math.round((stats.accepted / stats.total) * 100)
  return `建议（近 7 天）：${stats.total} 条 · 采纳 ${stats.accepted} · 忽略 ${stats.ignored} · 待定 ${stats.pending}（采纳率 ${rate}%）`
}
