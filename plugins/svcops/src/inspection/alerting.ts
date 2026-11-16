/**
 * G6 alert grading: collapse one inspection report into the three delivery
 * levels from docs/08 (静默 / 每日摘要 / 即时告警).
 *
 * Pure and status-driven — `fail` is immediate, `warn` is digest, everything
 * else is silent. `skipped` is not an anomaly and never creates noise. Actual
 * delivery, silencing windows and digest aggregation belong to the outbound
 * layer (module ⑥), so the level is recomputable from stored items.
 */

import type { InspectionItem, InspectionReport } from './checklist.js'

export type AlertLevel = 'silent' | 'digest' | 'immediate'

export interface AlertDecision {
  level: AlertLevel
  /** Human-readable reasons in checklist order; empty when silent. */
  reasons: string[]
}

function describe(item: InspectionItem): string {
  const detail = item.detail === undefined ? '' : `（${item.detail}）`
  return `${item.label}: ${item.value}${detail}`
}

export function gradeInspection(report: InspectionReport): AlertDecision {
  const failing = report.items.filter((item) => item.status === 'fail')
  if (failing.length > 0) return { level: 'immediate', reasons: failing.map(describe) }

  const warning = report.items.filter((item) => item.status === 'warn')
  if (warning.length > 0) return { level: 'digest', reasons: warning.map(describe) }

  return { level: 'silent', reasons: [] }
}
