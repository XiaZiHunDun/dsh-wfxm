/**
 * B2 v1: host-inspection findings become observe-only candidates. There is
 * intentionally no `auto` strength — v1 never creates tasks from a finding.
 * Keep the rule table a literal so every mapping is auditable.
 */

import type { InspectionReport } from './checklist.js'

/** v1 is observe-only; `auto` is deliberately absent from this union. */
export type CandidateStrength = 'observe'

export interface CandidateRule {
  ruleId: string
  title: string
  strength: CandidateStrength
}

export const CANDIDATE_RULES: Readonly<Record<string, CandidateRule>> = {
  disk: { ruleId: 'disk-pressure', title: '根分区使用率偏高', strength: 'observe' },
  memory: { ruleId: 'memory-pressure', title: '可用内存偏低', strength: 'observe' },
  load: { ruleId: 'load-high', title: '系统负载偏高', strength: 'observe' },
  units: { ruleId: 'failed-units', title: '存在失败的服务单元', strength: 'observe' },
  ports: { ruleId: 'missing-ports', title: '期望端口缺失', strength: 'observe' },
  logs: { ruleId: 'log-errors', title: '错误日志偏多', strength: 'observe' },
}

export interface CandidateInput {
  ruleId: string
  itemId: string
  target: string
  status: 'fail' | 'warn'
  /** The item's `value` at observation time. */
  observed: string
  detail?: string
}

/** Only `fail` / `warn` items produce candidates; unknown ids are ignored. */
export function deriveCandidates(report: InspectionReport, target: string): CandidateInput[] {
  const inputs: CandidateInput[] = []
  for (const item of report.items) {
    if (item.status !== 'fail' && item.status !== 'warn') continue
    const rule = CANDIDATE_RULES[item.id]
    if (rule === undefined) continue
    inputs.push({
      ruleId: rule.ruleId,
      itemId: item.id,
      target,
      status: item.status,
      observed: item.value,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
    })
  }
  return inputs
}
