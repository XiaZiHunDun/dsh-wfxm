-- v2：会前提醒只发一次，用 `reminded_at` 做库级去重。
ALTER TABLE calendar_events ADD COLUMN reminded_at TEXT;
