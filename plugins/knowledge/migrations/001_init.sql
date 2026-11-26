-- docs/15 §三 模块⑥: projects / memory_facts / memory_edges.
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  root_path      TEXT NOT NULL,
  rules_doc      TEXT,
  default_expert TEXT,
  created_at     TEXT NOT NULL,
  archived_at    TEXT
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('project','global')),
  project_id       TEXT,
  subject          TEXT NOT NULL,
  predicate        TEXT NOT NULL,
  value_json       TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN
                     ('user-confirmed','observed','inferred','summary')),
  kind             TEXT NOT NULL CHECK (kind IN ('environment','preference')),
  evidence_json    TEXT,
  last_injected_at TEXT,
  confidence       REAL,
  valid_from       TEXT NOT NULL,
  superseded_by    TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_facts_live
  ON memory_facts(scope, project_id, subject, predicate) WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS memory_edges (
  id           TEXT PRIMARY KEY,
  from_fact_id TEXT NOT NULL,
  relation     TEXT NOT NULL,
  to_fact_id   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_edges_from ON memory_edges(from_fact_id, relation);
