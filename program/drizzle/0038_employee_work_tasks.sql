CREATE TABLE IF NOT EXISTS `work_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL REFERENCES `organizations`(`id`),
  `project_id` text REFERENCES `projects`(`id`),
  `assignee_user_id` text NOT NULL REFERENCES `users`(`id`),
  `task_type` text NOT NULL,
  `title` text NOT NULL,
  `description` text,
  `target_count` integer NOT NULL DEFAULT 1,
  `completed_count` integer NOT NULL DEFAULT 0,
  `priority` text NOT NULL DEFAULT 'normal',
  `status` text NOT NULL DEFAULT 'pending',
  `starts_at` text NOT NULL,
  `due_at` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `updated_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_work_tasks_assignee_due` ON `work_tasks` (`organization_id`, `assignee_user_id`, `status`, `due_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_work_tasks_admin_due` ON `work_tasks` (`organization_id`, `status`, `due_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_work_tasks_project_type` ON `work_tasks` (`organization_id`, `project_id`, `task_type`, `created_at`);
