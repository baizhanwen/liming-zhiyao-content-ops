ALTER TABLE videos ADD COLUMN platform_title TEXT;
ALTER TABLE videos ADD COLUMN platform_description TEXT;
ALTER TABLE videos ADD COLUMN published_at_source TEXT;
ALTER TABLE videos ADD COLUMN metadata_status TEXT;
ALTER TABLE videos ADD COLUMN metadata_message TEXT;
ALTER TABLE videos ADD COLUMN metadata_attempted_at TEXT;
ALTER TABLE videos ADD COLUMN metadata_collected_at TEXT;
ALTER TABLE videos ADD COLUMN metadata_request_id TEXT;
CREATE UNIQUE INDEX idx_media_assets_active_platform_cover ON media_assets(organization_id, project_id, video_id)
  WHERE kind = 'platform_cover' AND status = 'active';
