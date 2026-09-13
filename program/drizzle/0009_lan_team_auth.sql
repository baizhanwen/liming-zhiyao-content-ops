CREATE TABLE `local_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`iterations` integer DEFAULT 210000 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_sessions_token_hash` ON `local_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_local_sessions_user_expiry` ON `local_sessions` (`user_id`,`expires_at`);
--> statement-breakpoint
PRAGMA optimize;
