/**
 * Fact card model and write-time validation (13 §2.3, 19 A1).
 *
 * Pure functions, no I/O. `memory_facts` has exactly one writer — this module
 * (AR23); everything below only prepares a row, the store persists it.
 */

import { createHash } from 'node:crypto'
import { redactText, type RedactHit } from '@dsh-wfxm/redact'

export type FactScope = 'project' | 'global'
export type FactSource = 'user-confirmed' | 'observed' | 'inferred' | 'summary'
/** `environment` can be re-probed; `preference` can only be confirmed by the owner. */
export type FactKind = 'environment' | 'preference'
/**
 * `match`      — a read-only probe agreed with the value at write time;
 * `unverified` — the probe could not decide (unavailable / non-whitelisted / no
 *                probe mounted). Writing is allowed, and the fact health check
 *                re-probes it later (19 A3: 探不到 ≠ 矛盾).
 */
export type FactVerification = 'match' | 'unverified'

export interface FactEvidence {
  /** Probe name, e.g. `path` / `package-manager` / `unit`. */
  probe: string
  /** What the probe saw; truncated to 200 chars (13 §2.3). `null` = probe unavailable. */
  value: string | null
  observedAt: string
  /** Environment fingerprint; used to notice "the environment changed". */
  fingerprint: string
  verification?: FactVerification
}

export interface MemoryFact {
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
  /** Last cold-boundary injection; `null` = never injected (19 D19-4). */
  lastInjectedAt: string | null
  validFrom: string
  /** Set on the old row when a newer fact replaces it; rows are never deleted. */
  supersededBy: string | null
  createdAt: string
}

export interface FactEvidenceInput {
  probe?: string
  value?: string | null
  observedAt?: string
  fingerprint?: string
}

export interface FactInput {
  subject: string
  predicate: string
  value: string
  source: FactSource
  kind: FactKind
  scope?: FactScope
  projectId?: string | null
  evidence?: FactEvidenceInput | null
  confidence?: number | null
  validFrom?: string
}

/** A validated row, ready for `store.insertFact` (id / timestamps are store-owned). */
export interface PreparedFact {
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
}

export type MemoryErrorCode =
  | 'invalid-fact'
  | 'evidence-required'
  | 'missing-project'
  | 'confidence-required'
  | 'invalid-confidence'
  | 'not-found'
  | 'conflict'

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message)
    this.name = 'MemoryError'
  }
}

const SOURCES: readonly FactSource[] = ['user-confirmed', 'observed', 'inferred', 'summary']
const KINDS: readonly FactKind[] = ['environment', 'preference']
const SCOPES: readonly FactScope[] = ['project', 'global']
const MAX_FIELD = 200
/** Probe output cap; keeps one bad `cat` from storing a whole file (19 §七). */
export const MAX_EVIDENCE_VALUE = 200

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new MemoryError('invalid-fact', `${field} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') throw new MemoryError('invalid-fact', `${field} must not be empty`)
  if (trimmed.length > MAX_FIELD) {
    throw new MemoryError('invalid-fact', `${field} exceeds ${MAX_FIELD} characters`)
  }
  return trimmed
}

function fingerprintOf(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}

/**
 * Validate one fact and redact it before it can reach storage (19 D19-2: the
 * memory write is one of the four `redact` mounts).
 */
export function prepareFact(
  input: FactInput,
  now: Date = new Date(),
): { fact: PreparedFact; redactions: RedactHit[] } {
  const subject = text(input.subject, 'subject')
  const predicate = text(input.predicate, 'predicate')
  if (typeof input.value !== 'string') {
    throw new MemoryError('invalid-fact', 'value must be a string')
  }
  if (!SOURCES.includes(input.source)) {
    throw new MemoryError('invalid-fact', `source must be one of ${SOURCES.join(' / ')}`)
  }
  if (!KINDS.includes(input.kind)) {
    throw new MemoryError('invalid-fact', `kind must be one of ${KINDS.join(' / ')}`)
  }
  const scope = input.scope ?? 'global'
  if (!SCOPES.includes(scope)) {
    throw new MemoryError('invalid-fact', `scope must be one of ${SCOPES.join(' / ')}`)
  }
  const projectId = input.projectId === undefined || input.projectId === null || input.projectId === ''
    ? null
    : text(input.projectId, 'projectId')
  if (scope === 'project' && projectId === null) {
    throw new MemoryError('missing-project', 'scope=project requires projectId')
  }
  // 跨项目知识边界（08 §七 #3 已定）：项目事实隔离、偏好共享。
  // 偏好永远全局（无 projectId）；带 projectId 的偏好会制造"同名不同值"的假隔离。
  if (input.kind === 'preference' && scope !== 'global') {
    throw new MemoryError('invalid-fact', 'kind=preference is shared across projects; use scope=global')
  }
  if (input.kind === 'preference' && projectId !== null) {
    throw new MemoryError('invalid-fact', 'kind=preference must not carry projectId')
  }

  // `inferred` never becomes a fact without an explicit confidence (13 §2.3 rule 3).
  const confidence: number | null = input.confidence ?? null
  if (confidence !== null && (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1)) {
    throw new MemoryError('invalid-confidence', 'confidence must be a number in (0, 1]')
  }
  if (input.source === 'inferred' && confidence === null) {
    throw new MemoryError('confidence-required', 'source=inferred requires confidence in (0, 1]')
  }

  const validFrom = input.validFrom ?? now.toISOString()
  if (Number.isNaN(Date.parse(validFrom))) {
    throw new MemoryError('invalid-fact', 'validFrom must be an ISO timestamp')
  }

  const redactions: RedactHit[] = []
  const redactedValue = redactText(input.value)
  redactions.push(...redactedValue.hits)

  let evidence: FactEvidence | null = null
  if (input.kind === 'environment') {
    if (input.evidence === undefined || input.evidence === null) {
      throw new MemoryError(
        'evidence-required',
        'kind=environment requires evidence { probe, value, observedAt, fingerprint }',
      )
    }
    const probe = text(input.evidence.probe ?? predicate, 'evidence.probe')
    const observedAt = input.evidence.observedAt ?? now.toISOString()
    if (Number.isNaN(Date.parse(observedAt))) {
      throw new MemoryError('invalid-fact', 'evidence.observedAt must be an ISO timestamp')
    }
    // The asserted value doubles as the probe output unless a caller says otherwise.
    const rawObserved = input.evidence.value === undefined ? redactedValue.value : input.evidence.value
    let observed: string | null = null
    if (rawObserved !== null) {
      const redactedObserved = redactText(String(rawObserved))
      redactions.push(...redactedObserved.hits)
      observed = redactedObserved.value.slice(0, MAX_EVIDENCE_VALUE)
    }
    evidence = {
      probe,
      value: observed,
      observedAt,
      fingerprint: input.evidence.fingerprint === undefined
        ? fingerprintOf(observed ?? redactedValue.value)
        : text(input.evidence.fingerprint, 'evidence.fingerprint'),
    }
  }

  return {
    fact: {
      scope,
      projectId,
      subject,
      predicate,
      value: redactedValue.value,
      source: input.source,
      kind: input.kind,
      evidence,
      confidence,
      validFrom,
    },
    redactions,
  }
}

/** Conflict grouping key: same subject + predicate in the same scope (13 §2.5). */
export function factKey(fact: Pick<MemoryFact, 'scope' | 'projectId' | 'subject' | 'predicate'>): string {
  return [fact.scope, fact.projectId ?? '', fact.subject, fact.predicate].join('\u0000')
}
