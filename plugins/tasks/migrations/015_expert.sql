-- O1 / Slice CH: explicit expert chosen by `/expert <name>`. Null means
-- "decide at execution time" (project default, then global default). The value
-- is intentionally not constrained by a CHECK: the registry lives in code and
-- unknown names must fail loudly at execution, not be silently coerced here.
ALTER TABLE tasks ADD COLUMN expert TEXT;
