CREATE TABLE IF NOT EXISTS `employee_work_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`),
  `project_id` text NOT NULL REFERENCES `projects`(`id`),
  `employee_user_id` text NOT NULL REFERENCES `users`(`id`),
  `report_type` text NOT NULL,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `title` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `generated_by` text NOT NULL REFERENCES `users`(`id`),
  `generated_at` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_employee_work_reports_scope_period` ON `employee_work_reports` (`project_id`, `employee_user_id`, `period_start`, `period_end`, `report_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_employee_work_reports_scope_generated` ON `employee_work_reports` (`organization_id`, `project_id`, `employee_user_id`, `generated_at`);
