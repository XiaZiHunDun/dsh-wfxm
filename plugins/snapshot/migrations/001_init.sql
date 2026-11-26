-- 快照与文件前像（13 §3.4）：locator 必须自包含（dir: / restic:）。
CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('workspace','task')),
  locator      TEXT NOT NULL,
  baseline_ref TEXT,
  excludes_json TEXT NOT NULL DEFAULT '[]',
  content_key  TEXT,
  ref_count    INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_snapshots_content ON snapshots(content_key) WHERE content_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_snapshots_kind ON snapshots(kind, created_at);

CREATE TABLE IF NOT EXISTS file_preimages (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  tool_call_id  TEXT NOT NULL,
  path          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('present','absent')),
  content_ref   TEXT,
  sha256        TEXT,
  size_bytes    INTEGER,
  checkpoint_id TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_file_preimages_call ON file_preimages(tool_call_id, path);
CREATE INDEX IF NOT EXISTS ix_file_preimages_task ON file_preimages(task_id, created_at);
