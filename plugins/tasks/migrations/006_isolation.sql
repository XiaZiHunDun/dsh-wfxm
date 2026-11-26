-- 11 §十四 / 15 §十 (B4-b): one isolation unit per task. `worktree` tasks carry
-- the checkout address and branch; `merge_state` stays `none` after success
-- (a ready branch is not a merge). Existing rows default to `serial`.
ALTER TABLE tasks ADD COLUMN isolation TEXT NOT NULL DEFAULT 'serial'
  CHECK (isolation IN ('serial','worktree'));
ALTER TABLE tasks ADD COLUMN worktree_path TEXT;
ALTER TABLE tasks ADD COLUMN base_commit TEXT;
ALTER TABLE tasks ADD COLUMN branch TEXT;
ALTER TABLE tasks ADD COLUMN merge_state TEXT NOT NULL DEFAULT 'none'
  CHECK (merge_state IN ('none','pending','merged','conflict','abandoned'));
ALTER TABLE tasks ADD COLUMN prepare_state TEXT NOT NULL DEFAULT 'none'
  CHECK (prepare_state IN ('none','running','done','failed'));
ALTER TABLE tasks ADD COLUMN prepared_at TEXT;
CREATE INDEX IF NOT EXISTS ix_tasks_isolation ON tasks(isolation, merge_state);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_worktree_path
  ON tasks(worktree_path) WHERE worktree_path IS NOT NULL;
