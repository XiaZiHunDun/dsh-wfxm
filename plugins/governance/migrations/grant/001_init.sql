-- docs/15 §三·模块 ③ 的 `grants` 正本（AR20：可枚举、可撤销、带来源与过期）。
-- `source_approval_id` 唯一：一次确认只产生一张授权，重复发放即拒绝。
CREATE TABLE IF NOT EXISTS grants (
  id                 TEXT PRIMARY KEY,
  actor_id           TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('once','session','forever')),
  scope_json         TEXT NOT NULL,
  source_approval_id TEXT,
  granted_at         TEXT NOT NULL,
  expires_at         TEXT,
  revoked_at         TEXT,
  consumed_at        TEXT,
  policy_version     TEXT
);
CREATE INDEX IF NOT EXISTS ix_grants_actor ON grants(actor_id, revoked_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_grants_source
  ON grants(source_approval_id) WHERE source_approval_id IS NOT NULL;
