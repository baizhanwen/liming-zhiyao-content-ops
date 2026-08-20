CREATE TABLE IF NOT EXISTS `platform_works` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `project_id` text NOT NULL,
  `platform` text NOT NULL DEFAULT 'douyin',
  `platform_work_id` text,
  `title` text NOT NULL,
  `title_normalized` text NOT NULL,
  `published_at` text NOT NULL,
  `genre` text,
  `review_status_raw` text,
  `review_status` text,
  `content_item_id` text,
  `publication_id` text,
  `match_status` text NOT NULL DEFAULT 'unmatched',
  `created_by` text NOT NULL,
  `updated_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `idx_platform_works_project_lookup` ON `platform_works` (`organization_id`, `project_id`, `title_normalized`, `published_at`, `genre`);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_works_project_platform_id` ON `platform_works` (`project_id`, `platform`, `platform_work_id`) WHERE `platform_work_id` IS NOT NULL;

CREATE TABLE IF NOT EXISTS `platform_metric_import_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `project_id` text NOT NULL,
  `platform` text NOT NULL DEFAULT 'douyin',
  `as_of_at` text NOT NULL,
  `source_hash` text NOT NULL,
  `original_filename` text,
  `status` text NOT NULL DEFAULT 'processing',
  `row_count` integer NOT NULL,
  `accepted_count` integer NOT NULL DEFAULT 0,
  `rejected_count` integer NOT NULL DEFAULT 0,
  `errors_json` text,
  `imported_by` text NOT NULL,
  `created_at` text NOT NULL,
  `completed_at` text
);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_metric_imports_project_hash_asof` ON `platform_metric_import_batches` (`project_id`, `source_hash`, `as_of_at`);
CREATE INDEX IF NOT EXISTS `idx_platform_metric_imports_project_created` ON `platform_metric_import_batches` (`organization_id`, `project_id`, `created_at`);

CREATE TABLE IF NOT EXISTS `platform_metric_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `project_id` text NOT NULL,
  `platform` text NOT NULL DEFAULT 'douyin',
  `work_id` text NOT NULL,
  `import_batch_id` text NOT NULL,
  `as_of_at` text NOT NULL,
  `views` integer NOT NULL DEFAULT 0,
  `completion_rate_bps` integer,
  `five_second_completion_rate_bps` integer,
  `cover_ctr_bps` integer,
  `two_second_bounce_rate_bps` integer,
  `avg_watch_ms` integer,
  `likes` integer NOT NULL DEFAULT 0,
  `shares` integer NOT NULL DEFAULT 0,
  `comments` integer NOT NULL DEFAULT 0,
  `saves` integer NOT NULL DEFAULT 0,
  `homepage_visits` integer NOT NULL DEFAULT 0,
  `follower_delta` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_platform_metric_snapshots_work_asof` ON `platform_metric_snapshots` (`work_id`, `as_of_at`);
CREATE INDEX IF NOT EXISTS `idx_platform_metric_snapshots_project_asof` ON `platform_metric_snapshots` (`organization_id`, `project_id`, `as_of_at`);

CREATE TABLE IF NOT EXISTS `platform_metric_import_errors` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `project_id` text NOT NULL,
  `import_batch_id` text NOT NULL,
  `row_number` integer NOT NULL,
  `error_code` text NOT NULL,
  `message` text NOT NULL,
  `raw_json` text,
  `created_at` text NOT NULL
);
CREATE INDEX IF NOT EXISTS `idx_platform_metric_errors_batch` ON `platform_metric_import_errors` (`import_batch_id`, `row_number`);
