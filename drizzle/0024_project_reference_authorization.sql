ALTER TABLE `project_video_references` ADD `status` text NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `project_video_references` ADD `revoked_by` text REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `project_video_references` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `project_video_references` ADD `revoke_reason` text;--> statement-breakpoint
CREATE INDEX `idx_project_video_refs_project_purpose_status_created` ON `project_video_references` (`organization_id`,`project_id`,`purpose`,`status`,`created_at`);
