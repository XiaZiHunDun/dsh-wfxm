-- docs/14 §四: one-time pairing codes. Only the sha256 hash of the code is
-- stored; the raw code is shown to the owner once at mint time. Codes are
-- short-lived (default 5 min) and consumed exactly once — a successful consume
-- also creates the channel binding atomically.
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash   TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  channel_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_pairing_codes_expiry ON pairing_codes(expires_at);
