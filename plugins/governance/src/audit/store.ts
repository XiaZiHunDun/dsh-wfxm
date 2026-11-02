import DatabaseConstructor, { type Database } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalRecord, chainHash, GENESIS_HASH } from './canonical.js'
import type { AuditFields } from './events.js'

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
  close(): void
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

  return {
    append: (fields) => appendTxn.immediate(fields),
    close: () => db.close(),
  }
}
