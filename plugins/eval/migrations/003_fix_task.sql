-- G2：finding → 修复任务的关联（dsh 任务 id）。
-- 与 promoted_task_id（eval 候选任务 id）分开：一个 finding 可以既有候选、又有修复任务。
ALTER TABLE eval_findings ADD COLUMN fix_task_id TEXT;

CREATE INDEX IF NOT EXISTS ix_eval_findings_fix_task
  ON eval_findings(fix_task_id) WHERE fix_task_id IS NOT NULL;
