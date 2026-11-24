/**
 * G5 memory maintenance (Slice CF): proposal cards.
 *
 * The owner is the only one who can confirm a preference-like memory, so the
 * model does not write silently: it files a **proposal** (`mem_propose`), the
 * owner answers in chat ("记住 <id>" / "不记 <id>"), and the confirmation
 * reuses the same write gate as `mem_remember` (`gateFact` + `insertFact`).
 *
 * Organization rules (v1, deterministic):
 *   - an identical live fact makes the proposal a no-op (`duplicate`);
 *   - a different live value turns it into `conflict` and suggests supersede;
 *   - more than one live value means the fact set is already conflicted, so no
 *     proposal is filed until the owner cleans it up;
 *   - pending proposals expire after `PROPOSAL_TTL_DAYS`, they are never
 *     auto-confirmed or auto-superseded.
 */

import type { FactEvidence, FactKind, FactScope, FactSource, PreparedFact } from './facts.js'

export type ProposalStatus = 'pending' | 'confirmed' | 'rejected' | 'expired'

export interface MemoryProposal {
  id: string
  scope: FactScope
  projectId: string | null
  subject: string
  predicate: string
  value: string
  source: FactSource
  kind: FactKind
  evidence: FactEvidence | null
  confidence: number | null
  validFrom: string
  /** Why this is worth remembering, shown to the owner. */
  reason: string
  status: ProposalStatus
  /** Set when the owner confirmed it. */
  factId: string | null
  /** Live fact this proposal replaces on confirmation, if any. */
  supersedes: string | null
  createdAt: string
  expiresAt: string
  resolvedAt: string | null
}

export interface ProposalInput {
  fact: PreparedFact
  reason: string
  expiresAt: string
  supersedes: string | null
}

export interface ProposalListOptions {
  status?: ProposalStatus
  limit?: number
}

/** 7 days is long enough for a weekly check-in, short enough to stay fresh. */
export const PROPOSAL_TTL_DAYS = 7

export function proposalExpiry(now: Date, ttlDays: number = PROPOSAL_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * 86_400_000).toISOString()
}

function ageDays(at: string, now: Date): number {
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, Math.floor((now.getTime() - parsed) / 86_400_000))
}

/**
 * One digest line for the patrol. Returns `null` when nothing is pending so a
 * quiet host stays quiet. The ids are what the owner replies with.
 */
export function formatPendingProposals(
  proposals: readonly MemoryProposal[],
  now: Date = new Date(),
  limit = 3,
): string | null {
  if (proposals.length === 0) return null
  const oldest = Math.max(...proposals.map((proposal) => ageDays(proposal.createdAt, now)))
  const lines = [`记忆提案：${proposals.length} 条待确认（最早 ${oldest} 天）`]
  for (const proposal of proposals.slice(0, limit)) {
    lines.push(`- ${proposal.id} ${proposal.subject}.${proposal.predicate} = ${proposal.value}`)
  }
  if (proposals.length > limit) lines.push(`- 其余 ${proposals.length - limit} 条见 mem_proposals`)
  lines.push('回复「记住 <id>」或「不记 <id>」；7 天未处理自动过期。')
  return lines.join('\n')
}
