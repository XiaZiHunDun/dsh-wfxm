-- B1 thread anchors (docs/15 §9.1).
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('topic','root')),
  topic_id    TEXT,
  root_msg_id TEXT,
  project_id  TEXT,
  created_at  TEXT NOT NULL,
  last_msg_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_thread_key
  ON threads(channel_id, chat_id, kind, COALESCE(topic_id,''), COALESCE(root_msg_id,''));
CREATE INDEX IF NOT EXISTS ix_threads_chat ON threads(channel_id, chat_id, last_msg_at);
