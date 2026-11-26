-- Slice CC / M8: per-day usage rollup so the daily token budget survives
-- restarts. The task row keeps the lifetime total; this table is the day view.
CREATE TABLE IF NOT EXISTS task_usage_daily (
  day           TEXT PRIMARY KEY,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
