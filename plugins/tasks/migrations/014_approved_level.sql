-- L2 risk grant: the level a human approved for this task. Only written by
-- `resumeFromApproval` when the approval's level matches the task's risk;
-- NULL means "no tool-level exemption" — the executor must never infer one
-- from `risk_level`.
ALTER TABLE tasks ADD COLUMN approved_level TEXT CHECK (approved_level IN ('R2','R3'));
