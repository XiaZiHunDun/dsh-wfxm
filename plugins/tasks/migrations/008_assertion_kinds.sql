-- v8: `unit_restarted` becomes an assertion kind. SQLite cannot alter a CHECK
-- constraint in place, so the table is rebuilt and copied (same columns, same
-- index) — existing rows are preserved verbatim.
CREATE TABLE task_assertions_v8 (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('exit_code','file_exists','port_listening','service_active','unit_restarted',
                   'http_status','git_diff_matches','page_contains')),
  spec_json     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','pass','fail','skipped')),
  evidence_json TEXT,
  checked_at    TEXT
);
INSERT INTO task_assertions_v8 (id, task_id, kind, spec_json, status, evidence_json, checked_at)
  SELECT id, task_id, kind, spec_json, status, evidence_json, checked_at FROM task_assertions;
DROP TABLE task_assertions;
ALTER TABLE task_assertions_v8 RENAME TO task_assertions;
CREATE INDEX IF NOT EXISTS ix_task_assertions_task ON task_assertions(task_id);
