/**
 * G4 v1 (docs/20 §三 Slice CD): daily suggestions derived from state that is
 * already collected. Rules come first — no model call — and the output is
 * advisory only: nothing here creates or modifies a task.
 */

import { CANDIDATE_RULES, type CandidateInput } from './inspection/candidates.js'

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

export interface SuggestionInput {
  candidates: CandidateInput[]
  failures: FailureBreakdown
  /** Facts flagged by `mem_health` as review candidates (>30 days unused). */
  reviewFacts: number
  budget?: SuggestionBudget | null
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

/**
 * Deterministic order: data integrity first, then repeated failure, cost, and
 * finally observations. `max` caps the list (default 3).
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
