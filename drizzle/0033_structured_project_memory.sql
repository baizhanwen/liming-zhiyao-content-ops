ALTER TABLE project_memory_items ADD COLUMN category text;
--> statement-breakpoint
UPDATE project_memory_items
SET status = 'expired', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE category IS NULL AND status IN ('candidate', 'confirmed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_memory_scope_status_category
ON project_memory_items (organization_id, project_id, status, category);
