-- Audit DDL from docs/15 §三·模块 ④ plus two metadata columns:
-- `session_id` / `session_seq` are query-only metadata and deliberately stay
-- outside the frozen canonical form (`seq|ts|actor_id|action|target|correlation_id|payload_digest`).
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
