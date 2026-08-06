CREATE TABLE `analyzer_workers` (
  `worker_id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'online' NOT NULL,
  `started_at` text NOT NULL,
  `last_seen_at` text NOT NULL,
  `last_error` text,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_analyzer_workers_last_seen` ON `analyzer_workers` (`last_seen_at`);
