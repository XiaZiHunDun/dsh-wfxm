-- inspections：单写者是模块⑦（docs/15 §三）。
CREATE TABLE IF NOT EXISTS inspections (
  id             TEXT PRIMARY KEY,
  checklist_id   TEXT NOT NULL,
  target         TEXT NOT NULL,
  status         TEXT NOT NULL,
  findings_json  TEXT NOT NULL,
  ran_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_inspections_target_time ON inspections(target, ran_at DESC);
