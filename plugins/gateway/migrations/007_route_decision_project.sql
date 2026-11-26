-- 11 §5.3.1: every routing decision records which project it resolved to and
-- how (`explicit` / `anchor` / `sticky` / `single` / `asked`), so a wrong answer
-- can be explained later without guessing.
ALTER TABLE route_decisions ADD COLUMN project_id TEXT;
ALTER TABLE route_decisions ADD COLUMN project_matched_by TEXT;
