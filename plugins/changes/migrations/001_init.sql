-- docs/15 §模块 ⑦: changes（AR33 / docs/11 §5.4）。`applying` = 半应用。
CREATE TABLE IF NOT EXISTS changes (
  id              TEXT PRIMARY KEY,
  task_id         TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('task','service','workspace')),
  target          TEXT NOT NULL,
  snapshot_id     TEXT,
  status          TEXT NOT NULL CHECK (status IN
                    ('applying','applied','verified','kept','failed','rolled_back')),
  rollback_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (rollback_status IN ('none','ready','done','failed')),
  detail          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_changes_task ON changes(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_changes_status ON changes(status, created_at);
