-- docs/15 §9.1 / §9.5: thread subscriptions, pending inputs, the read-only
-- anchor view consumed by ①, plus the two `tasks` columns.
-- `receipts.round` / `receipts.external_msg_id` shipped in v1 already.
ALTER TABLE tasks ADD COLUMN origin_msg_id TEXT;
ALTER TABLE tasks ADD COLUMN task_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_task_ref
  ON tasks(task_ref) WHERE task_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_threads (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  relation       TEXT NOT NULL CHECK (relation IN ('default_owner','anchor')),
  anchor_msg_id  TEXT,
  created_at     TEXT NOT NULL,
  released_at    TEXT,
  release_reason TEXT CHECK (release_reason IN ('handback','stopped','superseded','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_thread_live
  ON task_threads(task_id, thread_id, relation, COALESCE(anchor_msg_id,''))
  WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_thread_default_owner
  ON task_threads(thread_id) WHERE relation='default_owner' AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_task_threads_thread ON task_threads(thread_id, released_at);

CREATE TABLE IF NOT EXISTS task_inputs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  inbox_id     TEXT NOT NULL,
  round        INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','delivered','read','returned')),
  delivered_at TEXT,
  read_at      TEXT,
  error_code   TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_input_dedup ON task_inputs(task_id, inbox_id);
CREATE INDEX IF NOT EXISTS ix_task_inputs_pending ON task_inputs(task_id, status, round);

CREATE VIEW IF NOT EXISTS v_task_anchors AS
SELECT tt.task_id,
       tt.thread_id,
       COALESCE(tt.anchor_msg_id, tk.origin_msg_id) AS anchor_msg_id,
       tk.round,
       tk.status
FROM task_threads tt
JOIN tasks tk ON tk.id = tt.task_id
WHERE tt.released_at IS NULL;
