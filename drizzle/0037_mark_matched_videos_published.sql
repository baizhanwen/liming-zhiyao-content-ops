UPDATE `video_library_entries`
SET `category` = 'published',
    `updated_at` = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM `platform_works`
  WHERE `platform_works`.`organization_id` = `video_library_entries`.`organization_id`
    AND `platform_works`.`video_id` = `video_library_entries`.`source_video_id`
    AND `platform_works`.`match_status` = 'confirmed'
);