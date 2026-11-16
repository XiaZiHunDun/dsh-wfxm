/**
 * Write-time verification gate (19 A3, 13 §2.3 rule 3).
 *
 * Read-only and fail-soft: a probe that throws, is missing, or is not part of
 * the predicate whitelist yields `unverified` — never a rejection. Only an
 * explicit mismatch rejects the write, and even then the old value is kept.
 */

import type { FactVerification, PreparedFact } from './facts.js'

export type ProbeStatus = 'match' | 'mismatch' | 'unavailable'

export interface ProbeOutcome {
  status: ProbeStatus
  /** Redacted probe output; kept in evidence as the observation. */
  observed?: string
}

/** A read-only probe. `expected` is the value the fact asserts. */
export type FactProbe = (probe: string, expected: string | null) => ProbeOutcome | Promise<ProbeOutcome>

/**
 * Predicates we know how to probe, from the 13 §2.3 definition of
 * `kind=environment` (包管理器 / 运行时版本 / unit / 端口 / 路径 / 域名).
 * Anything outside it is written but left `unverified` — the whitelist itself
 * is still an open question (19 §九-1), so it stays a parameter.
 */
export const DEFAULT_ENVIRONMENT_PREDICATES: readonly string[] = [
  'package-manager',
  'runtime-version',
  'path',
  'unit',
  'port',
  'domain',
  'container',
]

export type GateDecision = 'accept' | 'accept-unverified' | 'reject'

export interface GateResult {
  decision: GateDecision
  /** What to store in `evidence.verification`. */
  verification: FactVerification
  reason: string
  observed?: string
}

export interface GateOptions {
  probe?: FactProbe
  /** Predicates allowed to reach the probe; defaults to DEFAULT_ENVIRONMENT_PREDICATES. */
  predicates?: readonly string[]
}

/**
 * Decide whether one validated fact may be written.
 * `preference` facts are never probed — they can only be confirmed by the owner.
 */
export async function gateFact(
  fact: PreparedFact,
  options: GateOptions = {},
): Promise<GateResult> {
  if (fact.kind !== 'environment') {
    return { decision: 'accept', verification: 'match', reason: 'preference fact; no probe applies' }
  }
  const probe = options.probe
  if (probe === undefined) {
    return { decision: 'accept-unverified', verification: 'unverified', reason: 'no probe mounted' }
  }
  const evidence = fact.evidence
  if (evidence === null) {
    // prepareFact already rejects this; keep the gate total for direct callers.
    return { decision: 'accept-unverified', verification: 'unverified', reason: 'environment fact without evidence' }
  }
  const allowed = options.predicates ?? DEFAULT_ENVIRONMENT_PREDICATES
  if (!allowed.includes(fact.predicate) && !allowed.includes(evidence.probe)) {
    return {
      decision: 'accept-unverified',
      verification: 'unverified',
      reason: `predicate ${JSON.stringify(fact.predicate)} is outside the probe whitelist`,
    }
  }
  if (evidence.value === null) {
    return {
      decision: 'accept-unverified',
      verification: 'unverified',
      reason: 'probe did not report a value (probe unavailable)',
    }
  }

  let outcome: ProbeOutcome
  try {
    outcome = await probe(evidence.probe, evidence.value)
  } catch (error) {
    return {
      decision: 'accept-unverified',
      verification: 'unverified',
      reason: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (outcome.status === 'match') {
    return {
      decision: 'accept',
      verification: 'match',
      reason: `probe ${evidence.probe} agreed`,
      ...outcome.observed === undefined ? {} : { observed: outcome.observed },
    }
  }
  if (outcome.status === 'mismatch') {
    return {
      decision: 'reject',
      verification: 'unverified',
      reason: `probe ${evidence.probe} contradicted the value${outcome.observed === undefined ? '' : `: ${outcome.observed}`}`,
      ...outcome.observed === undefined ? {} : { observed: outcome.observed },
    }
  }
  return {
    decision: 'accept-unverified',
    verification: 'unverified',
    reason: `probe ${evidence.probe} unavailable`,
    ...outcome.observed === undefined ? {} : { observed: outcome.observed },
  }
}
