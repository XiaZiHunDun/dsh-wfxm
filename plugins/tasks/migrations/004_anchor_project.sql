-- 11 §5.3.1: anchors also carry the task's project, so ① can inherit
-- "which project" from a reply without reading ⑤'s tables (AR33).
DROP VIEW IF EXISTS v_task_anchors;
CREATE VIEW v_task_anchors AS
SELECT tt.task_id,
       tt.thread_id,
       COALESCE(tt.anchor_msg_id, tk.origin_msg_id) AS anchor_msg_id,
       tk.round,
       tk.status,
       tk.project_id
FROM task_threads tt
JOIN tasks tk ON tk.id = tt.task_id
WHERE tt.released_at IS NULL;
