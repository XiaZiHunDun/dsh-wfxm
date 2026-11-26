-- eval_runs / eval_findings / eval_flags（P2-3 才会写 flags；先建表保证版本一次到位）。
CREATE TABLE IF NOT EXISTS eval_runs (
  id              TEXT PRIMARY KEY,
  suite           TEXT NOT NULL,
  runtime         TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('l2','snapshot')),
  status          TEXT NOT NULL CHECK (status IN ('running','ok','failed','timeout')),
  passed          INTEGER,
  total           INTEGER,
  advisory        INTEGER NOT NULL DEFAULT 1,
  report_ref      TEXT,
  triggered_by    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_eval_runs_started ON eval_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS eval_findings (
  id               TEXT PRIMARY KEY,
  run_id           TEXT,
  suite            TEXT NOT NULL DEFAULT '',
  task_id          TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL CHECK (severity IN ('fail','warn')),
  title            TEXT NOT NULL,
  detail_digest    TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('ci','flag')),
  status           TEXT NOT NULL CHECK (status IN ('open','promoted','ignored')),
  promoted_task_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_eval_findings_key
  ON eval_findings(run_id, suite, task_id);
CREATE INDEX IF NOT EXISTS ix_eval_findings_status
  ON eval_findings(status, created_at);

CREATE TABLE IF NOT EXISTS eval_flags (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  thread_id     TEXT,
  verdict       TEXT NOT NULL,
  reason_digest TEXT NOT NULL,
  trace_ref     TEXT,
  created_at    TEXT NOT NULL
);
