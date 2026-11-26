-- 策略判定记录（模块 ③）。
CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  correlation_id  TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('S1','S2','jev','fallback')),
  rule_id         TEXT,
  ruleset_version TEXT,
  input_digest    TEXT NOT NULL,
  verdict         TEXT NOT NULL,
  confidence      REAL,
  reason          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_decisions_corr ON decisions(correlation_id);
