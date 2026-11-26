-- docs/15 §9.3 step 2 (migrate): backfill from the old `thread_id` column.
UPDATE session_routes SET chat_id = thread_id WHERE chat_id IS NULL;
