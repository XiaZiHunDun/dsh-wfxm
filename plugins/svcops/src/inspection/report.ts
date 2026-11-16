/**
 * G3 minimal slice: turn the `inspections` history into one digest for a time
 * window. Pure aggregation — no I/O — so the window/count/dedup rules are
 * unit-testable. Task/session digests still belong to module ①.
 */

import { gradeInspection, type AlertLevel } from './alerting.js'
import type { InspectionItemStatus } from './checklist.js'
import type { InspectionRecord } from './store.js'

export interface InspectionDigestOptions {
  hours: number
  /** Upper bound for de-duplicated findings; keeps the digest readable. */
  maxFindings?: number
  now?: Date
}

export interface InspectionDigestLatest {
  id: string
  target: string
  /** Plain string: the digest round-trips through the tool output schema. */
  status: string
  ranAt: string
  level: string
}

export interface InspectionDigest {
  hours: number
  from: string
  to: string
  runs: number
  byStatus: Record<InspectionItemStatus, number>
  byAlert: Record<AlertLevel, number>
  latest: InspectionDigestLatest | null
  /** Newest first, de-duplicated, capped at `maxFindings`. */
  findings: string[]
}

export function summarize(
  records: InspectionRecord[],
  options: InspectionDigestOptions,
): InspectionDigest {
  const to = options.now ?? new Date()
  const from = new Date(to.getTime() - options.hours * 3_600_000)
  const maxFindings = options.maxFindings ?? 10

  const byStatus: Record<InspectionItemStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 }
  const byAlert: Record<AlertLevel, number> = { silent: 0, digest: 0, immediate: 0 }

  const inWindow = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.ranAt >= from.toISOString() && record.ranAt <= to.toISOString())
    .sort((a, b) => {
      if (a.record.ranAt !== b.record.ranAt) return a.record.ranAt < b.record.ranAt ? 1 : -1
      // Same millisecond: later inserts are newer (listSince returns oldest first).
      return b.index - a.index
    })
    .map(({ record }) => record)

  const findings: string[] = []
  const seen = new Set<string>()
  let latest: InspectionDigestLatest | null = null

  for (const record of inWindow) {
    const alert = gradeInspection({
      checklistId: record.checklistId,
      status: record.status,
      items: record.items,
    })
    byStatus[record.status] += 1
    byAlert[alert.level] += 1
    latest ??= {
      id: record.id,
      target: record.target,
      status: record.status,
      ranAt: record.ranAt,
      level: alert.level,
    }
    for (const reason of alert.reasons) {
      if (seen.has(reason) || findings.length >= maxFindings) continue
      seen.add(reason)
      findings.push(reason)
    }
  }

  return {
    hours: options.hours,
    from: from.toISOString(),
    to: to.toISOString(),
    runs: inWindow.length,
    byStatus,
    byAlert,
    latest,
    findings,
  }
}
