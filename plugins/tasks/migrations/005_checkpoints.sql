-- 13 §3.4: step boundaries. A checkpoint is opened by the executor around one
-- semantic step; pre-images captured while it is open carry its id, so a
-- failed step rolls back alone. `seq` is 1-based per task.
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  label      TEXT,
  status     TEXT NOT NULL CHECK (status IN ('open','committed','aborted')),
  created_at TEXT NOT NULL,
  closed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_checkpoints_seq ON task_checkpoints(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_task_checkpoints_task ON task_checkpoints(task_id, status);
