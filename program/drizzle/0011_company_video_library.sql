CREATE TABLE `video_library_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `source_video_id` text NOT NULL,
  `category` text DEFAULT 'other' NOT NULL,
  `tags_json` text DEFAULT '[]' NOT NULL,
  `notes` text,
  `created_by` text NOT NULL,
  `updated_by` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_video_library_org_source` ON `video_library_entries` (`organization_id`,`source_video_id`);
--> statement-breakpoint
CREATE INDEX `idx_video_library_org_category_updated` ON `video_library_entries` (`organization_id`,`category`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `project_video_references` (
  `id` text PRIMARY KEY NOT NULL,
  `organization_id` text NOT NULL,
  `project_id` text NOT NULL,
  `library_entry_id` text NOT NULL,
  `purpose` text DEFAULT 'benchmark' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`library_entry_id`) REFERENCES `video_library_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_video_refs_unique` ON `project_video_references` (`project_id`,`library_entry_id`,`purpose`);
--> statement-breakpoint
CREATE INDEX `idx_project_video_refs_project_purpose_created` ON `project_video_references` (`organization_id`,`project_id`,`purpose`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_project_video_refs_library` ON `project_video_references` (`organization_id`,`library_entry_id`);
--> statement-breakpoint
INSERT INTO `video_library_entries` (`id`,`organization_id`,`source_video_id`,`category`,`tags_json`,`notes`,`created_by`,`updated_by`,`created_at`,`updated_at`)
SELECT lower(hex(randomblob(16))), v.organization_id, v.id, 'other', '[]', NULL, v.created_by, v.updated_by, v.created_at, v.updated_at
FROM videos v
WHERE v.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM videos earlier
    WHERE earlier.organization_id = v.organization_id AND earlier.deleted_at IS NULL
      AND COALESCE(NULLIF(earlier.platform_work_id,''), NULLIF(earlier.source_url,''), NULLIF(earlier.source_hash,''), earlier.id)
        = COALESCE(NULLIF(v.platform_work_id,''), NULLIF(v.source_url,''), NULLIF(v.source_hash,''), v.id)
      AND (earlier.created_at < v.created_at OR (earlier.created_at = v.created_at AND earlier.id < v.id))
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `project_video_references` (`id`,`organization_id`,`project_id`,`library_entry_id`,`purpose`,`created_by`,`created_at`)
SELECT lower(hex(randomblob(16))), v.organization_id, v.project_id, library.id, 'benchmark', v.created_by, v.created_at
FROM videos v
INNER JOIN video_library_entries library ON library.organization_id = v.organization_id
INNER JOIN videos canonical ON canonical.id = library.source_video_id
  AND COALESCE(NULLIF(canonical.platform_work_id,''), NULLIF(canonical.source_url,''), NULLIF(canonical.source_hash,''), canonical.id)
    = COALESCE(NULLIF(v.platform_work_id,''), NULLIF(v.source_url,''), NULLIF(v.source_hash,''), v.id)
WHERE v.deleted_at IS NULL;
--> statement-breakpoint
PRAGMA optimize;
