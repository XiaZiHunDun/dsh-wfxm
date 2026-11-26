-- docs/15 §三·模块 ③: approvals。卡片只是视图，这张表才是审批正本（AR10）。
-- `nonce` 一次性；`external_msg_id` 供传输层回写卡片，不作为正本。
CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  task_id           TEXT,
  correlation_id    TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('R2','R3')),
  summary           TEXT NOT NULL,
  impact_json       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('pending','approved','rejected','expired','withdrawn')),
  requested_at      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  decided_at        TEXT,
  decided_by        TEXT,
  channel_id        TEXT,
  external_msg_id   TEXT,
  nonce             TEXT NOT NULL,
  nonce_consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_approvals_nonce ON approvals(nonce);
CREATE INDEX IF NOT EXISTS ix_approvals_pending ON approvals(status, requested_at);
