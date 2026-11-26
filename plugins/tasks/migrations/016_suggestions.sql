-- P7-3：建议有稳定 id 与状态；任务记录来源建议。
ALTER TABLE tasks ADD COLUMN suggestion_id TEXT;

CREATE TABLE suggestions (
  id          TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  digest_day  TEXT NOT NULL,
  ordinal     INTEGER NOT NULL DEFAULT 0,
  action      TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  risk        TEXT NOT NULL CHECK (risk IN ('R1','R2')),
  status      TEXT NOT NULL CHECK (status IN ('pending','accepted','ignored')),
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

CREATE INDEX ix_suggestions_status ON suggestions(status, created_at DESC);
CREATE INDEX ix_suggestions_day ON suggestions(digest_day, ordinal);
