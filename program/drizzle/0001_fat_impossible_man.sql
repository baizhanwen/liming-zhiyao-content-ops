CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_media_assets_r2_key` ON `media_assets` (`r2_key`);--> statement-breakpoint
CREATE INDEX `idx_media_assets_project_kind` ON `media_assets` (`organization_id`,`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE `social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`platform` text DEFAULT 'douyin' NOT NULL,
	`account_type` text NOT NULL,
	`display_name` text NOT NULL,
	`handle` text,
	`profile_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_social_accounts_project_type` ON `social_accounts` (`organization_id`,`project_id`,`account_type`);--> statement-breakpoint
CREATE TABLE `video_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`schema_version` text NOT NULL,
	`report_json` text NOT NULL,
	`confidence` integer,
	`model_provider` text,
	`model_name` text,
	`prompt_version` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_video_analyses_video_created` ON `video_analyses` (`organization_id`,`project_id`,`video_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `video_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`source` text NOT NULL,
	`plays` integer,
	`likes` integer,
	`comments` integer,
	`favorites` integer,
	`shares` integer,
	`followers_gained` integer,
	`collected_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_video_metrics_video_collected` ON `video_metric_snapshots` (`organization_id`,`project_id`,`video_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `video_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`language` text DEFAULT 'zh-CN' NOT NULL,
	`source` text NOT NULL,
	`full_text` text NOT NULL,
	`segments_json` text NOT NULL,
	`confidence` integer,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_transcripts_video_version` ON `video_transcripts` (`video_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_video_transcripts_project_video` ON `video_transcripts` (`organization_id`,`project_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`social_account_id` text,
	`media_asset_id` text,
	`platform` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`source_hash` text,
	`platform_work_id` text,
	`title` text,
	`author_name` text,
	`published_at` text,
	`duration_sec` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_videos_project_source_hash` ON `videos` (`organization_id`,`project_id`,`source_hash`);--> statement-breakpoint
CREATE INDEX `idx_videos_project_status_created` ON `videos` (`organization_id`,`project_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `video_id` text REFERENCES videos(id);
--> statement-breakpoint
PRAGMA optimize;
