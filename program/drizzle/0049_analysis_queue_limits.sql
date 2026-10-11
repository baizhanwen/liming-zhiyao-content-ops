-- Existing jobs retain their original submitter; retries are attributed to the
-- person who requests the retry. Execution attempts remain cumulative fences.
ALTER TABLE analysis_jobs ADD COLUMN queue_user_id TEXT REFERENCES users(id);
ALTER TABLE analysis_jobs ADD COLUMN enqueued_at TEXT;
ALTER TABLE analysis_jobs ADD COLUMN recovery_attempt_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX analysis_jobs_queue_user_idx ON analysis_jobs(queue_user_id, status);

-- SQLite serializes writers. These checks run inside the same transaction as
-- task creation, including URL, upload, reanalysis and manual retry paths.
CREATE TRIGGER analysis_queue_insert_limit BEFORE INSERT ON analysis_jobs
WHEN NEW.status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
BEGIN
  SELECT RAISE(ABORT, 'ANALYSIS_USER_QUEUE_FULL') WHERE
    (SELECT COUNT(*) FROM analysis_jobs WHERE COALESCE(queue_user_id,created_by) = COALESCE(NEW.queue_user_id,NEW.created_by)
      AND (status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
        OR (status = 'cancelled' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))) >= 10;
  SELECT RAISE(ABORT, 'ANALYSIS_HOST_QUEUE_FULL') WHERE
    (SELECT COUNT(*) FROM analysis_jobs WHERE status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
      OR (status = 'cancelled' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))) >= 50;
END;

CREATE TRIGGER analysis_queue_retry_limit BEFORE UPDATE OF status, queue_user_id ON analysis_jobs
WHEN NEW.status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
  AND (OLD.status NOT IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
    OR COALESCE(NEW.queue_user_id,NEW.created_by) != COALESCE(OLD.queue_user_id,OLD.created_by))
BEGIN
  SELECT RAISE(ABORT, 'ANALYZER_STOPPING') WHERE OLD.status = 'cancelled'
    AND OLD.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');
  SELECT RAISE(ABORT, 'ANALYSIS_USER_QUEUE_FULL') WHERE
    (SELECT COUNT(*) FROM analysis_jobs WHERE id != OLD.id AND COALESCE(queue_user_id,created_by) = COALESCE(NEW.queue_user_id,NEW.created_by)
      AND (status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
        OR (status = 'cancelled' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))) >= 10;
  SELECT RAISE(ABORT, 'ANALYSIS_HOST_QUEUE_FULL') WHERE
    (SELECT COUNT(*) FROM analysis_jobs WHERE id != OLD.id AND (status IN ('pending','queued','downloading','processing','transcribing','extracting','analyzing')
      OR (status = 'cancelled' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))) >= 50;
END;
