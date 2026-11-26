-- 11 §14.6 / 15 §10.4 (B4-b Phase 3): non-file resources. Keys are normalised
-- before insert, so the live unique index is the serialisation point for
-- ports / databases / units / docker projects / git merges.
CREATE TABLE IF NOT EXISTS resource_locks (
  id               TEXT PRIMARY KEY,
  resource_key     TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  released_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_resource_lock_live
  ON resource_locks(resource_key) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_resource_locks_lease
  ON resource_locks(released_at, lease_expires_at);
