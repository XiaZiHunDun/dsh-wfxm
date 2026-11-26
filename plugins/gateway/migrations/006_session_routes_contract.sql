-- docs/15 §9.3 step 3 (contract): rebuild with PK `(channel_id, chat_id,
-- session_kind)` and drop `thread_id`. The store passes a guard that refuses
-- half-migrated rows before this file runs.
CREATE TABLE session_routes_next (
  channel_id   TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('orchestrator','chat')),
  session_id   TEXT NOT NULL,
  project_id   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (channel_id, chat_id, session_kind)
);
INSERT INTO session_routes_next(channel_id, chat_id, session_kind, session_id, project_id, updated_at)
  SELECT channel_id, chat_id, session_kind, session_id, project_id, updated_at FROM session_routes;
DROP TABLE session_routes;
ALTER TABLE session_routes_next RENAME TO session_routes;
