-- 13 §3.3: the worker leases a claimed task and schedules retries.
-- `next_attempt_at` keeps a transient failure from being re-claimed instantly.
ALTER TABLE tasks ADD COLUMN next_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS ix_tasks_wake ON tasks(status, next_attempt_at);
