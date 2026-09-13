ALTER TABLE `analyzer_workers` ADD `browser_auth_status` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `analyzer_workers` ADD `browser_auth_browser` text;
--> statement-breakpoint
ALTER TABLE `analyzer_workers` ADD `browser_auth_checked_at` text;
--> statement-breakpoint
ALTER TABLE `analyzer_workers` ADD `browser_auth_message` text;
