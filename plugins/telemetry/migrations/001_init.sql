-- 遥测本地落盘：trace_events / task_attempts / telemetry_usage / telemetry_drops。
CREATE TABLE IF NOT EXISTS trace_events (
  id                   TEXT PRIMARY KEY,
  ts                   TEXT NOT NULL,
  level                TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  event                TEXT NOT NULL,
  trace_id             TEXT NOT NULL,
  span_id              TEXT NOT NULL,
  parent_span_id       TEXT,
  thread_id            TEXT,
  message_id           TEXT,
  project_id           TEXT,
  task_id              TEXT,
  task_ref             TEXT,
  round                INTEGER,
  attempt              INTEGER,
  phase                TEXT NOT NULL,
  status               TEXT,
  duration_ms          INTEGER,
  error_code           TEXT,
  error_kind           TEXT,
  error_message_digest TEXT,
  error_stack_digest   TEXT,
  error_retryable      INTEGER,
  error_message        TEXT,
  error_stack          TEXT,
  model_name           TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cost_usd             REAL,
  tool_name            TEXT,
  tool_args_digest     TEXT,
  tool_exit_code       INTEGER,
  tool_duration_ms     INTEGER,
  attrs_json           TEXT,
  bytes                INTEGER NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trace_events_task ON trace_events(task_id, ts);
CREATE INDEX IF NOT EXISTS ix_trace_events_trace ON trace_events(trace_id, ts);
CREATE INDEX IF NOT EXISTS ix_trace_events_created ON trace_events(created_at);
CREATE INDEX IF NOT EXISTS ix_trace_events_error
  ON trace_events(error_code, ts) WHERE error_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_attempts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  trace_id      TEXT NOT NULL,
  executor      TEXT,
  model         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('running','succeeded','failed','cancelled')),
  failure_kind  TEXT,
  error_code    TEXT,
  summary       TEXT,
  session_ref   TEXT,
  trace_ref     TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_attempts_key ON task_attempts(task_id, attempt);
CREATE INDEX IF NOT EXISTS ix_task_attempts_started ON task_attempts(started_at DESC);
CREATE INDEX IF NOT EXISTS ix_task_attempts_outcome ON task_attempts(outcome, finished_at);

CREATE TABLE IF NOT EXISTS telemetry_usage (
  key        TEXT PRIMARY KEY,
  bytes      INTEGER NOT NULL,
  events     INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_drops (
  day        TEXT NOT NULL,
  reason     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, reason)
);
