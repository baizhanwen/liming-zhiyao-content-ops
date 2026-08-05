CREATE TABLE `analysis_job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`job_id` text NOT NULL,
	`video_id` text,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`progress` integer,
	`worker_id` text,
	`details_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `analysis_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_analysis_job_events_job_created` ON `analysis_job_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_analysis_job_events_tenant_created` ON `analysis_job_events` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `last_heartbeat_at` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `result_key` text;--> statement-breakpoint
CREATE INDEX `idx_analysis_jobs_claimable` ON `analysis_jobs` (`status`,`lease_expires_at`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
