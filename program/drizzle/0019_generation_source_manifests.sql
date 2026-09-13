CREATE TABLE `generation_source_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`capability` text NOT NULL,
	`model_provider` text,
	`model_name` text,
	`source_manifest_json` text NOT NULL,
	`prompt_hash` text,
	`status` text NOT NULL DEFAULT 'started',
	`error_code` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_generation_source_manifests_trace` ON `generation_source_manifests` (`trace_id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_source_manifests_project_created` ON `generation_source_manifests` (`organization_id`,`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_generation_source_manifests_status_created` ON `generation_source_manifests` (`status`,`created_at`);
