ALTER TABLE analysis_jobs ADD COLUMN collection_mode TEXT NOT NULL DEFAULT 'anonymous'
  CHECK(collection_mode IN ('anonymous', 'cookie'));
