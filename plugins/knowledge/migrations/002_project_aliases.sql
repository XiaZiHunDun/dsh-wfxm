-- v2: 项目别名（11 §5.3.1）。`alias` 存小写归一值，主键即保证大小写不敏感的唯一性；
-- 归档不删别名，解析时 join `projects.archived_at IS NULL` 一并失效。
CREATE TABLE IF NOT EXISTS project_aliases (
  alias       TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aliases_project ON project_aliases(project_id);
