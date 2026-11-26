-- AR37: a finished task can be woken after ③ re-verifies the actor, and that
-- decision deserves its own audited action. SQLite cannot alter a CHECK
-- constraint, so the append-only table is rebuilt (triggers and indexes drop
-- with it and are recreated here).
CREATE TABLE route_decisions_next (
  id             TEXT PRIMARY KEY,
  trigger_id     TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN
                   ('answer','ack','ask','accept','attach','ignore','stop','wake')),
  target_task_id TEXT,
  thread_id      TEXT,
  reason         TEXT NOT NULL,
  confidence     REAL,
  prompt_version TEXT,
  created_at     TEXT NOT NULL,
  project_id     TEXT,
  project_matched_by TEXT
);
INSERT INTO route_decisions_next(
  id, trigger_id, action, target_task_id, thread_id, reason,
  confidence, prompt_version, created_at, project_id, project_matched_by
)
SELECT id, trigger_id, action, target_task_id, thread_id, reason,
       confidence, prompt_version, created_at, project_id, project_matched_by
  FROM route_decisions;
DROP TABLE route_decisions;
ALTER TABLE route_decisions_next RENAME TO route_decisions;
CREATE INDEX IF NOT EXISTS ix_route_decisions_trigger ON route_decisions(trigger_id, created_at);
CREATE INDEX IF NOT EXISTS ix_route_decisions_action  ON route_decisions(action, created_at);
CREATE TRIGGER IF NOT EXISTS route_decisions_no_update BEFORE UPDATE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS route_decisions_no_delete BEFORE DELETE ON route_decisions
  BEGIN SELECT RAISE(ABORT, 'route_decisions is append-only'); END;
