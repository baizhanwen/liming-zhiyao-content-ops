CREATE TABLE `published_copy_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text,
	`content_version_id` text,
	`publication_id` text,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`platform` text NOT NULL,
	`content_format` text NOT NULL,
	`published_at` text,
	`external_url` text,
	`character_count` integer NOT NULL,
	`paragraph_count` integer NOT NULL,
	`monetization_types_json` text NOT NULL DEFAULT '[]',
	`monetization_detail` text,
	`analysis_json` text NOT NULL,
	`performance_json` text NOT NULL DEFAULT '{}',
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`) REFERENCES `publication_records`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_published_copy_publication` ON `published_copy_records` (`publication_id`);
--> statement-breakpoint
CREATE INDEX `idx_published_copy_project_published` ON `published_copy_records` (`organization_id`,`project_id`,`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_published_copy_project_platform` ON `published_copy_records` (`organization_id`,`project_id`,`platform`,`updated_at`);
