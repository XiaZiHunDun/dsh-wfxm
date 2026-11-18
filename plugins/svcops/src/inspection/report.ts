/**
 * G3 minimal slice: turn the `inspections` history into one digest for a time
 * window. Pure aggregation — no I/O — so the window/count/dedup rules are
 * unit-testable. Task/session digests still belong to module ①.
 */

import { gradeInspection, type AlertLevel } from './alerting.js'
import type { InspectionItemStatus } from './checklist.js'
import type { CandidateDigest, InspectionRecord } from './store.js'

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

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local `MM-DD HH:mm`; the digest text is read by a human on this host. */
function shortTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/**
 * B2 v1 candidate block for the daily digest. Returns `null` when nothing was
 * opened/resolved and nothing is open, so a quiet host adds no section at all.
 */
export function formatCandidateDigest(digest: CandidateDigest): string | null {
  if (digest.opened === 0 && digest.resolved === 0 && digest.stillOpen === 0) return null
  const lines = [`候选：新增 ${digest.opened} · 恢复 ${digest.resolved} · 未决 ${digest.stillOpen}`]
  for (const item of digest.open.slice(0, 5)) {
    lines.push(
      `- ${item.title}（${item.lastObserved}，首次 ${shortTime(item.firstSeenAt)} / 最近 ${shortTime(item.lastSeenAt)}）`,
    )
  }
  return lines.join('\n')
}
