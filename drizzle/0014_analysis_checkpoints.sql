ALTER TABLE `analysis_jobs` ADD `checkpoint_stage` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `checkpoint_json` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `checkpoint_updated_at` text;--> statement-breakpoint
ALTER TABLE `analysis_jobs` ADD `resume_count` integer DEFAULT 0 NOT NULL;
