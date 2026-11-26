-- P7-4：finding 增加回放终态 verified / regressed，并记录判定时间。
-- SQLite 不能修改 CHECK 约束，只能重建表；旧行的两个新列为 NULL。
CREATE TABLE eval_findings_v2 (
  id               TEXT PRIMARY KEY,
  run_id           TEXT,
  suite            TEXT NOT NULL DEFAULT '',
  task_id          TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL CHECK (severity IN ('fail','warn')),
  title            TEXT NOT NULL,
  detail_digest    TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('ci','flag')),
  status           TEXT NOT NULL CHECK (status IN ('open','promoted','ignored','verified','regressed')),
  promoted_task_id TEXT,
  verified_at      TEXT,
  regressed_at     TEXT,
  created_at       TEXT NOT NULL
);

INSERT INTO eval_findings_v2(
  id, run_id, suite, task_id, severity, title, detail_digest,
  source, status, promoted_task_id, created_at
)
SELECT id, run_id, suite, task_id, severity, title, detail_digest,
       source, status, promoted_task_id, created_at
  FROM eval_findings;

DROP TABLE eval_findings;
ALTER TABLE eval_findings_v2 RENAME TO eval_findings;

CREATE UNIQUE INDEX IF NOT EXISTS ux_eval_findings_key
  ON eval_findings(run_id, suite, task_id);
CREATE INDEX IF NOT EXISTS ix_eval_findings_status
  ON eval_findings(status, created_at);
CREATE INDEX IF NOT EXISTS ix_eval_findings_promoted
  ON eval_findings(promoted_task_id) WHERE promoted_task_id IS NOT NULL;
