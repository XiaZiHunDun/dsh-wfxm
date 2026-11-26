-- Idempotency key for producers that may retry (e.g. ⑤ receipt closure).
ALTER TABLE outbox ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_dedupe
  ON outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
