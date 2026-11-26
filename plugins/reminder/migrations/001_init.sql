-- J5: 提醒只落在创建它的线程（11 §SchedPort），host 的 pump 到点入队。
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  text          TEXT NOT NULL,
  due_at        TEXT NOT NULL,
  repeat        TEXT NOT NULL CHECK (repeat IN ('none','daily','weekly')),
  status        TEXT NOT NULL CHECK (status IN ('pending','done','cancelled')),
  source_msg_id TEXT,
  created_at    TEXT NOT NULL,
  fired_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_reminders_due ON reminders(status, due_at);
CREATE INDEX IF NOT EXISTS ix_reminders_thread ON reminders(thread_id, status, due_at);
