-- Keep historical jobs and older insert clients on their original serial path.
-- New submission APIs explicitly choose controlled_parallel unless overridden.
ALTER TABLE analysis_jobs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'serial'
  CHECK(execution_mode IN ('serial', 'controlled_parallel'));
