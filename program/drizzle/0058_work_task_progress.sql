-- Existing assignments continue to use their business counts until explicitly reported.
ALTER TABLE work_tasks ADD COLUMN progress_mode TEXT NOT NULL DEFAULT 'count';
ALTER TABLE work_tasks ADD COLUMN progress_percent INTEGER CHECK (progress_percent BETWEEN 0 AND 100);
ALTER TABLE work_tasks ADD COLUMN progress_note TEXT;
ALTER TABLE work_tasks ADD COLUMN next_step TEXT;
ALTER TABLE work_tasks ADD COLUMN blocker TEXT;
ALTER TABLE work_tasks ADD COLUMN delivery_url TEXT;
ALTER TABLE work_tasks ADD COLUMN delivery_requirements TEXT;
ALTER TABLE work_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_tasks ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX idx_work_tasks_request ON work_tasks(organization_id, created_by, request_id);

CREATE TABLE work_task_updates (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT,
  request_payload TEXT,
  action TEXT NOT NULL,
  previous_percent INTEGER,
  progress_percent INTEGER,
  status TEXT NOT NULL,
  note TEXT,
  next_step TEXT,
  blocker TEXT,
  delivery_url TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_work_task_updates_request ON work_task_updates(task_id, actor_user_id, request_id);
CREATE INDEX idx_work_task_updates_task_time ON work_task_updates(task_id, created_at DESC);
CREATE INDEX idx_work_task_updates_time ON work_task_updates(created_at DESC);

INSERT INTO work_task_updates (id, task_id, actor_user_id, action, status, created_at)
SELECT id, id, created_by, 'created', 'pending', created_at FROM work_tasks;

-- The historical audit log did not record a progress percentage for count edits.
INSERT INTO work_task_updates (id, task_id, actor_user_id, action, progress_percent, status, created_at)
SELECT 'audit-' || audit.id, task.id, audit.actor_user_id,
  CASE WHEN audit.action = 'work_task.cancelled' THEN 'cancel'
       WHEN json_extract(audit.metadata_json, '$.action') IN ('complete','reopen') THEN json_extract(audit.metadata_json, '$.action')
       ELSE 'count' END,
  CASE WHEN audit.action != 'work_task.cancelled' AND (json_extract(audit.metadata_json, '$.action') = 'complete'
    OR CAST(json_extract(audit.metadata_json, '$.completedCount') AS INTEGER) >= task.target_count) THEN 100 END,
  CASE WHEN audit.action = 'work_task.cancelled' THEN 'cancelled'
       WHEN json_extract(audit.metadata_json, '$.action') = 'complete' OR CAST(json_extract(audit.metadata_json, '$.completedCount') AS INTEGER) >= task.target_count THEN 'completed'
       WHEN CAST(json_extract(audit.metadata_json, '$.completedCount') AS INTEGER) > 0 THEN 'in_progress'
       ELSE 'pending' END, audit.created_at
FROM audit_logs audit JOIN work_tasks task ON task.id = audit.target_id AND task.organization_id = audit.organization_id
WHERE audit.target_type = 'work_task' AND audit.action IN ('work_task.cancelled','work_task.progress_updated')
  AND audit.actor_user_id IS NOT NULL AND json_valid(audit.metadata_json);
