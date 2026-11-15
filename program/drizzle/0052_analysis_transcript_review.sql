-- Existing jobs retain their historical AI transcript review behavior.
ALTER TABLE analysis_jobs ADD COLUMN transcript_review_enabled INTEGER NOT NULL DEFAULT 1
  CHECK(transcript_review_enabled IN (0, 1));
