import DatabaseConstructor from 'better-sqlite3'
import { canonicalRecord, chainHash, GENESIS_HASH } from './canonical.js'

export interface VerifyResult {
  ok: boolean
  checked: number
  reason?: string
  badSeq?: number
}

interface AuditRow {
  seq: number
  ts: string
  actor_id: string | null
  action: string
  target: string | null
  correlation_id: string | null
  payload_digest: string
  prev_hash: string | null
  hash: string
}

/** Recompute the chain from seq = 1; any mismatch means the chain is broken. */
export function verifyAuditChain(dbPath: string): VerifyResult {
  const db = new DatabaseConstructor(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT seq, ts, actor_id, action, target, correlation_id, payload_digest, prev_hash, hash
         FROM audit_log ORDER BY seq`,
      )
      .all() as AuditRow[]

    let expectedPrev = GENESIS_HASH
    let expectedSeq = 1
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, checked: expectedSeq - 1, reason: `seq gap: expected ${expectedSeq}, got ${row.seq}`, badSeq: row.seq }
      }
      if ((row.prev_hash ?? '') !== expectedPrev) {
        return { ok: false, checked: expectedSeq - 1, reason: `prev_hash mismatch`, badSeq: row.seq }
      }
      const canonical = canonicalRecord({
        seq: row.seq,
        ts: row.ts,
        actorId: row.actor_id,
        action: row.action,
        target: row.target,
        correlationId: row.correlation_id,
        payloadDigest: row.payload_digest,
      })
      const recomputed = chainHash(expectedPrev, canonical)
      if (recomputed !== row.hash) {
        return { ok: false, checked: expectedSeq - 1, reason: `hash mismatch`, badSeq: row.seq }
      }
      expectedPrev = row.hash
      expectedSeq += 1
    }
    return { ok: true, checked: rows.length }
  } finally {
    db.close()
  }
}
