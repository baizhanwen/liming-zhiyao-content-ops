-- Records contain counts only, never prompts, Cookie contents or API keys.
-- A started call with no final acknowledgement has unknown outcome/cost.
CREATE TABLE analysis_model_calls (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES analysis_jobs(id),
  attempt INTEGER NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
  output_budget INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX analysis_model_calls_job_idx ON analysis_model_calls(job_id, created_at);
