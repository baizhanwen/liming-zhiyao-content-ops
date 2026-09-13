CREATE TABLE `performance_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`original_filename` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`row_count` integer NOT NULL,
	`accepted_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`errors_json` text,
	`imported_by` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`imported_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_performance_imports_project_hash` ON `performance_import_batches` (`project_id`,`source_hash`);--> statement-breakpoint
CREATE INDEX `idx_performance_imports_project_created` ON `performance_import_batches` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `performance_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`report_type` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`summary` text NOT NULL,
	`metrics_json` text NOT NULL,
	`highlights_json` text NOT NULL,
	`recommendations_json` text NOT NULL,
	`generated_by` text NOT NULL,
	`generated_at` text NOT NULL,
	`finalized_by` text,
	`finalized_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finalized_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_performance_reports_project_period_type` ON `performance_reports` (`project_id`,`period_start`,`period_end`,`report_type`);--> statement-breakpoint
CREATE INDEX `idx_performance_reports_project_status_generated` ON `performance_reports` (`organization_id`,`project_id`,`status`,`generated_at`);--> statement-breakpoint
CREATE TABLE `publication_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`import_batch_id` text,
	`observed_at` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`comments` integer DEFAULT 0 NOT NULL,
	`shares` integer DEFAULT 0 NOT NULL,
	`saves` integer DEFAULT 0 NOT NULL,
	`followers_gained` integer DEFAULT 0 NOT NULL,
	`leads` integer DEFAULT 0 NOT NULL,
	`average_watch_seconds` integer,
	`completion_rate_bps` integer,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`) REFERENCES `publication_records`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `performance_import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publication_metrics_publication_observed` ON `publication_metric_snapshots` (`publication_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_publication_metrics_project_observed` ON `publication_metric_snapshots` (`organization_id`,`project_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_publication_metrics_content_observed` ON `publication_metric_snapshots` (`content_item_id`,`observed_at`);--> statement-breakpoint
PRAGMA optimize;
