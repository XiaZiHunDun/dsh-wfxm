-- docs/15 §三 模块⑤: tasks / task_events / task_assertions / receipts.
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT,
  conversation_id TEXT,
  session_id      TEXT,
  start_cursor    TEXT,
  intent          TEXT NOT NULL,
  risk_level      TEXT NOT NULL CHECK (risk_level IN ('R0','R1','R2','R3')),
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','running','waiting_approval','waiting_input',
                     'paused','succeeded','failed','cancelled')),
  plan_json       TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 2,
  lease_owner     TEXT,
  lease_expires_at TEXT,
  correlation_id  TEXT NOT NULL,
  round           INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS ix_tasks_lease  ON tasks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS task_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_events_seq ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS ix_task_events_task ON task_events(task_id, created_at);
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
  BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;

CREATE TABLE IF NOT EXISTS task_assertions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('exit_code','file_exists','port_listening','service_active',
                   'http_status','git_diff_matches','page_contains')),
  spec_json     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','pass','fail','skipped')),
  evidence_json TEXT,
  checked_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_task_assertions_task ON task_assertions(task_id);

CREATE TABLE IF NOT EXISTS receipts (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  round            INTEGER,
  summary          TEXT NOT NULL,
  evidence_locator TEXT,
  external_msg_id  TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_receipts_task ON receipts(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_receipts_round
  ON receipts(task_id, round) WHERE round IS NOT NULL;
