ALTER TABLE `media_assets` ADD `analysis_job_id` text REFERENCES analysis_jobs(id);
--> statement-breakpoint
ALTER TABLE `video_analyses` ADD `analysis_job_id` text REFERENCES analysis_jobs(id);
--> statement-breakpoint
UPDATE `video_analyses`
SET `analysis_job_id` = (
  SELECT j.id
  FROM analysis_jobs j
  WHERE j.organization_id = video_analyses.organization_id
    AND j.project_id = video_analyses.project_id
    AND j.video_id = video_analyses.video_id
    AND j.status IN ('completed', 'partial')
    AND j.completed_at = video_analyses.created_at
  ORDER BY j.created_at DESC
  LIMIT 1
)
WHERE `analysis_job_id` IS NULL;
--> statement-breakpoint
UPDATE `media_assets`
SET `analysis_job_id` = (
  SELECT j.id
  FROM analysis_jobs j
  WHERE j.organization_id = media_assets.organization_id
    AND j.project_id = media_assets.project_id
    AND j.video_id = media_assets.video_id
    AND j.status IN ('completed', 'partial')
    AND j.created_at <= media_assets.created_at
    AND j.completed_at >= media_assets.created_at
  ORDER BY j.created_at DESC
  LIMIT 1
)
WHERE `analysis_job_id` IS NULL
  AND `kind` IN ('keyframe', 'subtitle', 'report');
--> statement-breakpoint
CREATE INDEX `idx_media_assets_analysis_job_kind`
  ON `media_assets` (`analysis_job_id`, `kind`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_video_analyses_analysis_job`
  ON `video_analyses` (`analysis_job_id`);
