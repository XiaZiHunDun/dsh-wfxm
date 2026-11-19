import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalRecord, chainHash, GENESIS_HASH } from './canonical.js'
import type { AuditFields } from './events.js'
import { verifyAuditRows, type VerifyResult } from './verify.js'

const MIGRATION_MODULE = 'audit'
const MIGRATION_VERSION = 1

/**
 * Audit DDL from docs/15 §三·模块 ④ plus two metadata columns:
 * `session_id` / `session_seq` are query-only metadata and deliberately stay
 * outside the frozen canonical form (`seq|ts|actor_id|action|target|correlation_id|payload_digest`).
 */
const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL,
  session_id      TEXT,
  session_seq     INTEGER,
  ts              TEXT NOT NULL,
  actor_id        TEXT,
  action          TEXT NOT NULL,
  target          TEXT,
  correlation_id  TEXT,
  payload_digest  TEXT NOT NULL,
  prev_hash       TEXT,
  hash            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_session_event
  ON audit_log(session_id, session_seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`

const MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  module      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  applied_at  TEXT NOT NULL,
  PRIMARY KEY (module, version)
);
`

export interface AppendResult {
  seq: number
  hash: string
}

export interface AuditStore {
  /** Returns null when the same (session_id, session_seq) was already recorded. */
  append(fields: AuditFields): AppendResult | null
  /** Newest-first page for the read-only admin surface (H3). */
  query(input?: AuditQueryInput): AuditQueryResult
  /** Recompute the hash chain over the live database (H3 追溯). */
  verifyChain(): VerifyResult
  close(): void
}

export interface AuditQueryInput {
  actorId?: string
  action?: string
  target?: string
  /** Inclusive ISO lower bound on `ts`. */
  from?: string
  /** Exclusive ISO upper bound on `ts`. */
  to?: string
  /** 1..500; defaults to 100. */
  limit?: number
  /** Cursor: only rows with `seq < beforeSeq`. */
  beforeSeq?: number
}

export interface AuditRecord {
  seq: number
  id: string
  sessionId: string | null
  sessionSeq: number | null
  ts: string
  actorId: string | null
  action: string
  target: string | null
  correlationId: string | null
  payloadDigest: string
  prevHash: string | null
  hash: string
}

export interface AuditQueryResult {
  rows: AuditRecord[]
  /** Rows matching the filter, not just this page. */
  count: number
  /** Set when older rows exist; pass back as `beforeSeq`. */
  nextBeforeSeq: number | null
}

interface AuditRecordRow {
  seq: number
  id: string
  session_id: string | null
  session_seq: number | null
  ts: string
  actor_id: string | null
  action: string
  target: string | null
  correlation_id: string | null
  payload_digest: string
  prev_hash: string | null
  hash: string
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function toRecord(row: AuditRecordRow): AuditRecord {
  return {
    seq: row.seq,
    id: row.id,
    sessionId: row.session_id,
    sessionSeq: row.session_seq,
    ts: row.ts,
    actorId: row.actor_id,
    action: row.action,
    target: row.target,
    correlationId: row.correlation_id,
    payloadDigest: row.payload_digest,
    prevHash: row.prev_hash,
    hash: row.hash,
  }
}

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16)
  const ts = BigInt(now)
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function migrate(db: Database): void {
  db.exec(MIGRATIONS_DDL)
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?')
    .get(MIGRATION_MODULE) as { version: number | null } | undefined
  if ((row?.version ?? 0) >= MIGRATION_VERSION) return

  const apply = db.transaction(() => {
    db.exec(AUDIT_DDL)
    db.prepare('INSERT INTO schema_migrations(module, version, applied_at) VALUES (?, ?, ?)').run(
      MIGRATION_MODULE,
      MIGRATION_VERSION,
      new Date().toISOString(),
    )
  })
  apply.immediate()
}

export function createAuditStore(dbPath: string): AuditStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseConstructor(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  migrate(db)

  const readLast = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
  const exists = db.prepare('SELECT 1 AS present FROM audit_log WHERE session_id = ? AND session_seq = ? LIMIT 1')
  const insert = db.prepare(`
    INSERT INTO audit_log
      (seq, id, session_id, session_seq, ts, actor_id, action, target, correlation_id, payload_digest, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const appendTxn = db.transaction((fields: AuditFields): AppendResult | null => {
    if (fields.sessionId !== null && fields.sessionSeq !== null && exists.get(fields.sessionId, fields.sessionSeq)) {
      return null
    }
    const last = readLast.get() as { seq: number; hash: string } | undefined
    const seq = last ? last.seq + 1 : 1
    const prevHash = last ? last.hash : GENESIS_HASH
    const ts = new Date(fields.time).toISOString()
    const canonical = canonicalRecord({
      seq,
      ts,
      actorId: fields.actorId,
      action: fields.action,
      target: fields.target,
      correlationId: fields.correlationId,
      payloadDigest: fields.payloadDigest,
    })
    const hash = chainHash(prevHash, canonical)
    insert.run(
      seq,
      uuidv7(fields.time),
      fields.sessionId,
      fields.sessionSeq,
      ts,
      fields.actorId,
      fields.action,
      fields.target,
      fields.correlationId,
      fields.payloadDigest,
      prevHash,
      hash,
    )
    return { seq, hash }
  })

  function query(input: AuditQueryInput = {}): AuditQueryResult {
    const clauses: string[] = []
    const params: Record<string, string | number> = {}
    if (input.actorId !== undefined) {
      clauses.push('actor_id = @actorId')
      params.actorId = input.actorId
    }
    if (input.action !== undefined) {
      clauses.push('action = @action')
      params.action = input.action
    }
    if (input.target !== undefined) {
      clauses.push('target = @target')
      params.target = input.target
    }
    if (input.from !== undefined) {
      clauses.push('ts >= @from')
      params.from = input.from
    }
    if (input.to !== undefined) {
      clauses.push('ts < @to')
      params.to = input.to
    }
    if (input.beforeSeq !== undefined) {
      clauses.push('seq < @beforeSeq')
      params.beforeSeq = input.beforeSeq
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)))
    const counted = db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
      .get(params) as { n: number }
    const rows = db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY seq DESC LIMIT @limit`)
      .all({ ...params, limit: limit + 1 }) as AuditRecordRow[]
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      rows: page.map(toRecord),
      count: counted.n,
      nextBeforeSeq: rows.length > limit && last !== undefined ? last.seq : null,
    }
  }

  function verifyChain(): VerifyResult {
    const rows = db
      .prepare(
        `SELECT seq, ts, actor_id, action, target, correlation_id, payload_digest, prev_hash, hash
         FROM audit_log ORDER BY seq`,
      )
      .all() as AuditRecordRow[]
    return verifyAuditRows(rows)
  }

  return {
    append: (fields) => appendTxn.immediate(fields),
    query,
    verifyChain,
    close: () => db.close(),
  }
}
