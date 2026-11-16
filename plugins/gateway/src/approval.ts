/**
 * Approval answers (module ①, docs/14 §五/§六).
 *
 * The card is only a view: `approvals` in ③ is the approval of record (AR10).
 * ① therefore never decides anything — it parses the button value, hands the
 * nonce to ③ and mirrors the outcome on the inbox row. ③ is reached through an
 * injected port so ① does not import ③ and does not read its tables (AR33).
 */

import type { Json, JsonObject } from './model.js'

/** What the card buttons carry (docs/14 §五). `details` stays read-only. */
export type CardDecision = 'approved' | 'rejected' | 'details' | 'confirm'

export interface CardAction {
  approvalId: string
  decision: CardDecision
  /** Empty for `details`: nothing may be decided without a nonce. */
  nonce: string
}

export type CardActionProblem = 'not-an-approval' | 'missing-approval-id' | 'invalid-decision'

export interface CardActionParse {
  action: CardAction | null
  problem: CardActionProblem | null
}

const APPROVE = new Set(['approve', 'approved'])
const REJECT = new Set(['reject', 'rejected'])
const CONFIRM = new Set(['confirm', 'confirmed'])

function pickString(content: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = content[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/**
 * Parse a `card.action.trigger` payload. Accepts Feishu's snake_case value and
 * camelCase (tests / other channels). Anything that is not an approval answer
 * is reported as such instead of being guessed at.
 */
export function parseCardAction(content: Json): CardActionParse {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return { action: null, problem: 'not-an-approval' }
  }
  const value = content as JsonObject
  const approvalId = pickString(value, ['approval_id', 'approvalId'])
  if (approvalId === null) return { action: null, problem: 'missing-approval-id' }

  const raw = pickString(value, ['decision', 'action'])
  if (raw === null) return { action: null, problem: 'invalid-decision' }
  const decision = raw.toLowerCase()
  const nonce = pickString(value, ['nonce']) ?? ''

  if (APPROVE.has(decision)) return { action: { approvalId, decision: 'approved', nonce }, problem: null }
  if (REJECT.has(decision)) return { action: { approvalId, decision: 'rejected', nonce }, problem: null }
  if (decision === 'details') return { action: { approvalId, decision: 'details', nonce }, problem: null }
  if (CONFIRM.has(decision)) return { action: { approvalId, decision: 'confirm', nonce }, problem: null }
  return { action: null, problem: 'invalid-decision' }
}

export interface ApprovalAnswerInput {
  approvalId: string
  /** `confirmed` is R3's second click; ③ is the judge of whether it is valid. */
  decision: 'approved' | 'rejected' | 'confirmed'
  actorId: string
  nonce: string
}

/** Mirrors ③ `AnswerResult` without importing it (AR33). */
export interface ApprovalAnswerReport {
  ok: boolean
  /** ③'s `AnswerCode` (`ok` / `nonce-invalid` / `not-pending` / `expired` / …). */
  code: string
  status?: string
  /**
   * Task the approval belongs to, read from ③'s record after a successful
   * answer (Slice I). Absent for approvals that are not about a task.
   */
  taskId?: string
  /** Task status after the host applied the decision (`queued` / `paused` / …). */
  taskStatus?: string
  /** R3: 1 once the first "approve" click was recorded but not settled. */
  stage?: number
  /** R3 `confirm-required` only: the still-unconsumed nonce for the second card. */
  nonce?: string
}

/** Host-composed call onto ③ `answer`; absent means "no approval store mounted". */
export interface ApprovalAnswerPort {
  answer(input: ApprovalAnswerInput): ApprovalAnswerReport
}

/** What the caller (host) sees; enough to patch the card it rendered. */
export interface ApprovalAnswerOutcome extends ApprovalAnswerReport {
  approvalId: string
  decision: 'approved' | 'rejected' | 'confirmed'
}

// -- read-only details (Slice L) -----------------------------------------------------------

export interface ApprovalDetailAssertion {
  kind: string
  status?: string
  spec?: Json
}

export interface ApprovalDetailTask {
  taskId: string
  taskRef?: string | null
  intent?: string | null
  riskLevel?: string | null
  status?: string | null
  plan?: Json
  assertions?: ApprovalDetailAssertion[]
}

/**
 * Protocol-neutral detail view of one approval. Rendering is the channel's job;
 * ① only carries the data, and reading it never touches `status` / `nonce`.
 */
export interface ApprovalDetail {
  approvalId: string
  level: string
  summary: string
  status: string
  stage?: number
  requestedAt?: string | null
  expiresAt?: string | null
  decidedAt?: string | null
  decidedBy?: string | null
  impact?: Json
  task?: ApprovalDetailTask | null
}

export interface ApprovalDetailReport {
  ok: boolean
  code: string
  detail?: ApprovalDetail
}

export interface ApprovalDetailOutcome extends ApprovalDetailReport {
  approvalId: string
}

/** Host-composed read onto ③ + ⑤; absent means "details unavailable". */
export interface ApprovalDetailPort {
  details(input: { approvalId: string; actorId: string }): ApprovalDetailReport
}
