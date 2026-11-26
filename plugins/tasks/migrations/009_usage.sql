-- Slice BK / I5: cumulative model usage per task. Additive columns keep every
-- existing query (`SELECT *`) working; old rows read as NULL.
ALTER TABLE tasks ADD COLUMN input_tokens INTEGER;
ALTER TABLE tasks ADD COLUMN output_tokens INTEGER;
ALTER TABLE tasks ADD COLUMN cost_usd REAL;
