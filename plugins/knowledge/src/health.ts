/**
 * Fact health check (13 §2.5, 19 A2) and review candidates (19 D19-4).
 *
 * Five classes: 冲突 / 过期 / 无来源 / 孤儿 / 失效. Nothing here mutates a fact:
 * staleness is reported (`stale`), never auto-superseded; unreferenced facts
 * become review candidates, never demoted.
 */

import { factKey, type MemoryFact } from './facts.js'
import type { MemoryStore } from './store.js'
import type { FactProbe } from './verify.js'

export type HealthCheck = 'conflict' | 'expired' | 'no-source' | 'orphan' | 'stale'

export interface HealthFinding {
  check: HealthCheck
  factId: string
  subject: string
  predicate: string
  detail: string
}

export interface ReviewCandidate {
  factId: string
  subject: string
  predicate: string
  lastInjectedAt: string | null
  createdAt: string
  ageDays: number
}

export interface HealthReport {
  checkedAt: string
  scanned: number
  status: 'ok' | 'warn'
  counts: Record<HealthCheck, number>
  findings: HealthFinding[]
  reviewCandidates: ReviewCandidate[]
  /** Environment facts whose probe could not decide; not findings (探不到 ≠ 失效). */
  probeUnavailable: number
}

export interface HealthOptions {
  store: MemoryStore
  now?: Date
  probe?: FactProbe
  /** `valid_from` / observation older than this is reported as `expired`. */
  expiredDays?: number
  /** Zero injection for this long puts a fact in the review list. */
  unreferencedDays?: number
}

const DAY_MS = 86_400_000

function ageDays(at: string, now: Date): number {
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, (now.getTime() - parsed) / DAY_MS)
}

export async function checkFacts(options: HealthOptions): Promise<HealthReport> {
  const now = options.now ?? new Date()
  const expiredDays = options.expiredDays ?? 90
  const unreferencedDays = options.unreferencedDays ?? 30
  const facts = options.store.liveFacts()
  const projectIds = new Set(options.store.listProjects({ includeArchived: true }).map((p) => p.id))
  const findings: HealthFinding[] = []
  const reviewCandidates: ReviewCandidate[] = []
  let probeUnavailable = 0

  // 冲突：同 subject+predicate 多条 active —— 告警，不自动择一。
  const groups = new Map<string, MemoryFact[]>()
  for (const fact of facts) {
    const key = factKey(fact)
    groups.set(key, [...groups.get(key) ?? [], fact])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const fact of group) {
      findings.push({
        check: 'conflict',
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        detail: `${group.length} active facts share this subject+predicate; owner must choose`,
      })
    }
  }

  for (const fact of facts) {
    // 过期：写下很久且未被观测确认。
    const age = ageDays(fact.validFrom, now)
    const observedAge = fact.evidence === null ? age : ageDays(fact.evidence.observedAt, now)
    if (age > expiredDays && observedAge > expiredDays) {
      findings.push({
        check: 'expired',
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        detail: `valid since ${fact.validFrom} (${age.toFixed(0)}d) with no recent confirmation`,
      })
    }

    // 无来源：旧数据里 `inferred` 却没有置信度（写时校验已挡住新写入）。
    if (fact.source === 'inferred' && fact.confidence === null) {
      findings.push({
        check: 'no-source',
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        detail: 'source=inferred without confidence',
      })
    }

    // 孤儿：指向不存在（或已注销）的项目。
    if (fact.scope === 'project' && (fact.projectId === null || !projectIds.has(fact.projectId))) {
      findings.push({
        check: 'orphan',
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        detail: fact.projectId === null
          ? 'scope=project without projectId'
          : `project ${fact.projectId} does not exist`,
      })
    }

    // 失效：environment 事实复探不符 —— 标 stale 待复核，不自动取代。
    if (fact.kind === 'environment' && fact.evidence !== null && options.probe !== undefined) {
      if (fact.evidence.value === null) {
        probeUnavailable += 1
      } else {
        let mismatch: string | undefined
        try {
          const outcome = await options.probe(fact.evidence.probe, fact.evidence.value)
          if (outcome.status === 'mismatch') mismatch = outcome.observed ?? 'value changed'
          if (outcome.status === 'unavailable') probeUnavailable += 1
        } catch {
          probeUnavailable += 1
        }
        if (mismatch !== undefined) {
          findings.push({
            check: 'stale',
            factId: fact.id,
            subject: fact.subject,
            predicate: fact.predicate,
            detail: `probe ${fact.evidence.probe} no longer agrees: ${mismatch}`,
          })
        }
      }
    }

    // 复核候选：超过 N 天未被装配引用 —— 只提示，不降权、不归档。
    const lastSeen = fact.lastInjectedAt ?? fact.createdAt
    const idle = ageDays(lastSeen, now)
    if (idle > unreferencedDays) {
      reviewCandidates.push({
        factId: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        lastInjectedAt: fact.lastInjectedAt,
        createdAt: fact.createdAt,
        ageDays: Math.floor(idle),
      })
    }
  }

  const counts: Record<HealthCheck, number> = {
    conflict: findings.filter((f) => f.check === 'conflict').length,
    expired: findings.filter((f) => f.check === 'expired').length,
    'no-source': findings.filter((f) => f.check === 'no-source').length,
    orphan: findings.filter((f) => f.check === 'orphan').length,
    stale: findings.filter((f) => f.check === 'stale').length,
  }

  return {
    checkedAt: now.toISOString(),
    scanned: facts.length,
    status: findings.length === 0 ? 'ok' : 'warn',
    counts,
    findings,
    reviewCandidates,
    probeUnavailable,
  }
}

const HEALTH_LABELS: Record<HealthCheck, string> = {
  conflict: '冲突',
  expired: '过期',
  'no-source': '无来源',
  orphan: '孤儿',
  stale: '失效',
}

export interface HealthDigestOptions {
  maxFindings?: number
  maxReviewCandidates?: number
}

/**
 * O2 (Slice BU): one digest section for the patrol. Returns `null` when there
 * is nothing to say (no findings and no review candidates) so quiet hosts stay
 * quiet. Probe-unavailable is shown as a note, never as a finding.
 */
export function formatFactHealth(
  report: HealthReport,
  options: HealthDigestOptions = {},
): string | null {
  const total = Object.values(report.counts).reduce((sum, count) => sum + count, 0)
  if (total === 0 && report.reviewCandidates.length === 0) return null
  const maxFindings = options.maxFindings ?? 5
  const maxReviewCandidates = options.maxReviewCandidates ?? 3
  const lines = [
    `扫描 ${report.scanned} 条：冲突 ${report.counts.conflict} / 过期 ${report.counts.expired}`
    + ` / 无来源 ${report.counts['no-source']} / 孤儿 ${report.counts.orphan} / 失效 ${report.counts.stale}`,
  ]
  for (const finding of report.findings.slice(0, maxFindings)) {
    lines.push(
      `- ${HEALTH_LABELS[finding.check]}：${finding.subject}.${finding.predicate}（${finding.factId}）`,
    )
  }
  if (report.reviewCandidates.length > 0) {
    lines.push(`- 复核候选 ${report.reviewCandidates.length} 条（>30 天未被引用）`)
    for (const candidate of report.reviewCandidates.slice(0, maxReviewCandidates)) {
      lines.push(`  - ${candidate.subject}.${candidate.predicate}（${candidate.ageDays} 天）`)
    }
  }
  if (report.probeUnavailable > 0) {
    lines.push(`探针不可用 ${report.probeUnavailable} 条，未计失效`)
  }
  lines.push('只提示，不自动取代。')
  return lines.join('\n')
}
