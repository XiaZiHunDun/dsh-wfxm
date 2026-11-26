-- docs/15 §9.3 step 1 (expand): the channel chat id gets its own column.
ALTER TABLE session_routes ADD COLUMN chat_id TEXT;
