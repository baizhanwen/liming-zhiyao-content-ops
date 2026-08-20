ALTER TABLE `media_assets` ADD `is_cover` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `media_assets` ADD `quality_score` integer;
--> statement-breakpoint
CREATE INDEX `idx_media_assets_video_cover_quality` ON `media_assets` (`organization_id`,`project_id`,`video_id`,`kind`,`is_cover`,`quality_score`);
