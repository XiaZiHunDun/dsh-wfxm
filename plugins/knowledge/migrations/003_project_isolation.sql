-- 15 §10.3 (B4-b): project-level isolation defaults. Existing rows keep
-- `none` / `manual`; the worktree planner still verifies the repo at run time.
-- The store backfills `vcs='git'` for existing repositories after this file
-- applies (a filesystem check cannot live in pure SQL).
ALTER TABLE projects ADD COLUMN vcs TEXT NOT NULL DEFAULT 'none'
  CHECK (vcs IN ('git','none'));
ALTER TABLE projects ADD COLUMN prepare_cmd TEXT;
ALTER TABLE projects ADD COLUMN worktree_root TEXT;
ALTER TABLE projects ADD COLUMN merge_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (merge_mode IN ('manual','pr'));
