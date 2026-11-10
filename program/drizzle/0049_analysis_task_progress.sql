-- Activity is advanced only by real stage/observation changes, never by reads or liveness heartbeats.
ALTER TABLE analysis_jobs ADD COLUMN started_at TEXT;
ALTER TABLE analysis_jobs ADD COLUMN stage_started_at TEXT;
ALTER TABLE analysis_jobs ADD COLUMN last_progress_at TEXT;
ALTER TABLE analysis_jobs ADD COLUMN progress_json TEXT;
-- Legacy completed/failed/cancelled clocks stay unknown without an observed start.
