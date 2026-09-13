ALTER TABLE `media_assets` ADD `video_id` text REFERENCES videos(id);--> statement-breakpoint
CREATE INDEX `idx_media_assets_video_kind` ON `media_assets` (`organization_id`,`project_id`,`video_id`,`kind`);
--> statement-breakpoint
PRAGMA optimize;
