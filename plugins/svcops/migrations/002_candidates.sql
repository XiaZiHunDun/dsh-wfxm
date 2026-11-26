-- v2：巡检候选（同规则+条目+目标去重）。
CREATE TABLE IF NOT EXISTS inspection_candidates (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  title          TEXT NOT NULL,
  target         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  last_observed  TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  resolved_at    TEXT,
  seen_count     INTEGER NOT NULL DEFAULT 1,
  UNIQUE(rule_id, item_id, target)
);
CREATE INDEX IF NOT EXISTS ix_inspection_candidates_target_status
  ON inspection_candidates(target, status);
