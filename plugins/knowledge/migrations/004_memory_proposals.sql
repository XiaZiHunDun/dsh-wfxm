-- v4: 记忆提案（G5）。提案不写事实；owner 确认后才走 `gateFact` + `insertFact`。
-- 过期只是状态迁移，不删除行。
CREATE TABLE IF NOT EXISTS memory_proposals (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('project','global')),
  project_id     TEXT,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  value_json     TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN
                   ('user-confirmed','observed','inferred','summary')),
  kind           TEXT NOT NULL CHECK (kind IN ('environment','preference')),
  evidence_json  TEXT,
  confidence     REAL,
  valid_from     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired')),
  fact_id        TEXT,
  supersedes     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_proposals_status
  ON memory_proposals(status, created_at);
