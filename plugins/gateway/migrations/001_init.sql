-- docs/15 §三 模块①: inbox / actors / channel_bindings / session_routes /
-- route_decisions / outbox. `session_routes` still uses the pre-§9.3
-- `thread_id` column here; v4–v6 rename it in three steps.
CREATE TABLE IF NOT EXISTS inbox (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  msg_id          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('message','card_action','control')),
  actor_id        TEXT,
  content_json    TEXT NOT NULL,
  chat_id         TEXT,
  thread_id       TEXT,
  reply_to_msg_id TEXT,
  status          TEXT NOT NULL CHECK (status IN
                    ('accepted','triaged','routed','done','failed','rejected')),
  error_code      TEXT,
  received_at     TEXT NOT NULL,
  processed_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbox_dedup ON inbox(channel_id, msg_id);
CREATE INDEX IF NOT EXISTS ix_inbox_status ON inbox(status, received_at);

CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('owner','system')),
  display_name TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id               TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  bound_at         TEXT NOT NULL,
  revoked_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_binding_live
  ON channel_bindings(channel_id, external_user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS session_routes (
  channel_id   TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
  session_id   TEXT NOT NULL,
  project_id   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (channel_id, thread_id, session_kind)
);

CREATE TABLE IF NOT EXISTS route_decisions (
  id             TEXT PRIMARY KEY,
  trigger_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN
                   ('answer','ack','ask','accept','attach','ignore','stop')),
  target_task_id TEXT,
  thread_id      TEXT,
  reason         TEXT NOT NULL,
  confidence     REAL,
  prompt_version TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_route_decisions_trigger ON route_decisions(trigger_id, created_at);
CREATE INDEX IF NOT EXISTS ix_route_decisions_action  ON route_decisions(action, created_at);
CREATE TRIGGER IF NOT EXISTS route_decisions_no_update BEFORE UPDATE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS route_decisions_no_delete BEFORE DELETE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;

CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  topic            TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','sent','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  external_msg_id  TEXT,
  last_error       TEXT,
  task_id          TEXT,
  thread_id        TEXT,
  reply_to_msg_id  TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_outbox_thread  ON outbox(thread_id, status, next_retry_at);
