import { createHash } from 'node:crypto'

/** Frozen hash-chain genesis (64 zeroes) for seq = 1. */
export const GENESIS_HASH = '0'.repeat(64)

export interface CanonicalRecord {
  seq: number
  ts: string
  actorId: string | null
  action: string
  target: string | null
  correlationId: string | null
  payloadDigest: string
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Deterministic JSON encoding: object keys are sorted recursively, so the
 * same payload always produces the same digest regardless of key order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * Canonical string from docs/15 §三·模块 ④:
 * `seq|ts|actor_id|action|target|correlation_id|payload_digest`, nulls as empty
 * strings. The `hash` itself is never part of the canonical form.
 */
export function canonicalRecord(record: CanonicalRecord): string {
  return [
    record.seq,
    record.ts,
    record.actorId ?? '',
    record.action,
    record.target ?? '',
    record.correlationId ?? '',
    record.payloadDigest,
  ].join('|')
}

/** hash = sha256(prev_hash + canonical). */
export function chainHash(prevHash: string, canonical: string): string {
  return sha256Hex(prevHash + canonical)
}
