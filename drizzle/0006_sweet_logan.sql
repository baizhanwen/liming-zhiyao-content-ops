CREATE TABLE `content_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`visibility` text NOT NULL,
	`body` text NOT NULL,
	`anchor_json` text,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_content_comments_item_version_created` ON `content_comments` (`content_item_id`,`content_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_content_comments_project_visibility_created` ON `content_comments` (`organization_id`,`project_id`,`visibility`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`review_stage` text NOT NULL,
	`round` integer NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`requested_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_reviews_item_stage_round` ON `content_reviews` (`content_item_id`,`review_stage`,`round`);--> statement-breakpoint
CREATE INDEX `idx_content_reviews_project_decision_requested` ON `content_reviews` (`organization_id`,`project_id`,`decision`,`requested_at`);--> statement-breakpoint
CREATE TABLE `content_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`platform` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`notes` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_schedules_active_item` ON `content_schedules` (`content_item_id`) WHERE "content_schedules"."status" != 'cancelled';--> statement-breakpoint
CREATE INDEX `idx_content_schedules_project_time` ON `content_schedules` (`organization_id`,`project_id`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `publication_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`schedule_id` text,
	`platform` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`external_id` text,
	`external_url` text,
	`published_at` text,
	`error_message` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `content_schedules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_publication_records_project_status_updated` ON `publication_records` (`organization_id`,`project_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_publication_records_item_created` ON `publication_records` (`content_item_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
