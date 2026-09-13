CREATE TABLE `organization_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`plan_code` text DEFAULT 'team' NOT NULL,
	`project_quota` integer DEFAULT 20 NOT NULL,
	`member_quota` integer DEFAULT 50 NOT NULL,
	`monthly_analysis_quota` integer DEFAULT 500 NOT NULL,
	`monthly_model_call_quota` integer DEFAULT 2000 NOT NULL,
	`storage_quota_bytes` integer DEFAULT 21474836480 NOT NULL,
	`retention_days` integer DEFAULT 365 NOT NULL,
	`failed_job_alert_threshold` integer DEFAULT 3 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_settings_org` ON `organization_settings` (`organization_id`);