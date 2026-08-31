ALTER TABLE `platform_works` ADD COLUMN `video_id` text;
ALTER TABLE `platform_works` ADD COLUMN `match_confidence` integer;
ALTER TABLE `platform_works` ADD COLUMN `match_method` text;
ALTER TABLE `platform_works` ADD COLUMN `matched_by` text;
ALTER TABLE `platform_works` ADD COLUMN `matched_at` text;
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_works_project_video` ON `platform_works` (`project_id`, `video_id`) WHERE `video_id` IS NOT NULL;
