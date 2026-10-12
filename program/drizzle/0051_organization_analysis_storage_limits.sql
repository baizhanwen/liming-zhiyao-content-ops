-- Add write-time limits without changing existing data or capacity settings.
-- Missing legacy settings use the same bounded defaults as 0008. Public quota
-- preflight initializes/overrides settings with the actual licensed plan.
CREATE INDEX analysis_jobs_org_created_idx ON analysis_jobs(organization_id,created_at);
CREATE INDEX media_assets_org_status_size_idx ON media_assets(organization_id,status,size_bytes);

CREATE TRIGGER analysis_monthly_insert_limit BEFORE INSERT ON analysis_jobs
WHEN NEW.status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
BEGIN
  SELECT RAISE(ABORT,'ORGANIZATION_CAPACITY_INVALID') WHERE EXISTS(
    SELECT 1 FROM organization_settings WHERE organization_id=NEW.organization_id
      AND (typeof(monthly_analysis_quota)!='integer' OR monthly_analysis_quota<0));
  SELECT RAISE(ABORT,'ANALYSIS_MONTHLY_QUOTA_EXCEEDED') WHERE
    (SELECT COUNT(*) FROM analysis_jobs WHERE organization_id=NEW.organization_id
      AND created_at>=strftime('%Y-%m-01T00:00:00.000Z','now')
      AND created_at<strftime('%Y-%m-%dT00:00:00.000Z','now','start of month','+1 month')
      AND idempotency_key NOT LIKE 'material-import:%')
    >= COALESCE((SELECT monthly_analysis_quota FROM organization_settings WHERE organization_id=NEW.organization_id),500);
END;

CREATE TRIGGER media_storage_insert_limit BEFORE INSERT ON media_assets
WHEN NEW.status='active'
BEGIN
  SELECT RAISE(ABORT,'MEDIA_SIZE_INVALID') WHERE typeof(NEW.size_bytes)!='integer' OR NEW.size_bytes<0;
  SELECT RAISE(ABORT,'ORGANIZATION_CAPACITY_INVALID') WHERE EXISTS(
    SELECT 1 FROM organization_settings WHERE organization_id=NEW.organization_id
      AND (typeof(storage_quota_bytes)!='integer' OR storage_quota_bytes<0));
  SELECT RAISE(ABORT,'MEDIA_STORAGE_QUOTA_EXCEEDED') WHERE NEW.size_bytes+
    (SELECT COALESCE(SUM(MAX(size_bytes,0)),0) FROM media_assets WHERE organization_id=NEW.organization_id AND status='active')
    > COALESCE((SELECT storage_quota_bytes FROM organization_settings WHERE organization_id=NEW.organization_id),21474836480);
END;

CREATE TRIGGER media_storage_update_limit BEFORE UPDATE OF status,size_bytes,organization_id ON media_assets
WHEN NEW.status='active' AND (OLD.status!='active' OR NEW.organization_id!=OLD.organization_id OR NEW.size_bytes!=OLD.size_bytes)
BEGIN
  SELECT RAISE(ABORT,'MEDIA_SIZE_INVALID') WHERE typeof(NEW.size_bytes)!='integer' OR NEW.size_bytes<0;
  -- A lowered quota must not prevent reducing usage in the same organization.
  SELECT RAISE(ABORT,'ORGANIZATION_CAPACITY_INVALID') WHERE
    (OLD.status!='active' OR NEW.organization_id!=OLD.organization_id OR NEW.size_bytes>OLD.size_bytes)
    AND EXISTS(SELECT 1 FROM organization_settings WHERE organization_id=NEW.organization_id
      AND (typeof(storage_quota_bytes)!='integer' OR storage_quota_bytes<0));
  SELECT RAISE(ABORT,'MEDIA_STORAGE_QUOTA_EXCEEDED') WHERE
    (OLD.status!='active' OR NEW.organization_id!=OLD.organization_id OR NEW.size_bytes>OLD.size_bytes)
    AND NEW.size_bytes+(SELECT COALESCE(SUM(MAX(size_bytes,0)),0) FROM media_assets
      WHERE organization_id=NEW.organization_id AND status='active' AND id!=OLD.id)
    > COALESCE((SELECT storage_quota_bytes FROM organization_settings WHERE organization_id=NEW.organization_id),21474836480);
END;
