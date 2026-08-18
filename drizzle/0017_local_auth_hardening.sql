CREATE TABLE `local_login_attempts` (
	`email` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_local_login_attempts_lock` ON `local_login_attempts` (`locked_until`);
--> statement-breakpoint
PRAGMA optimize;
