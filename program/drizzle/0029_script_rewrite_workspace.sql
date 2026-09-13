-- Script rewrite workspaces, runs, and immutable versions.
CREATE TABLE IF NOT EXISTS script_rewrite_workspaces (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  source_type text NOT NULL,
  source_video_id text REFERENCES videos(id),
  source_transcript_id text REFERENCES video_transcripts(id),
  source_transcript_version integer,
  source_analysis_id text REFERENCES video_analyses(id),
  source_label text NOT NULL,
  source_text text NOT NULL,
  source_hash text NOT NULL,
  source_character_count integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_rewrites_scope_updated ON script_rewrite_workspaces (organization_id, project_id, status, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_rewrites_video ON script_rewrite_workspaces (organization_id, project_id, source_video_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS script_rewrite_runs (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  workspace_id text NOT NULL REFERENCES script_rewrite_workspaces(id) ON DELETE CASCADE,
  variant text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  source_version_id text NOT NULL,
  result_version_id text,
  retry_of_run_id text,
  estimated_call_count integer NOT NULL,
  estimated_input_tokens integer NOT NULL,
  maximum_output_tokens integer NOT NULL,
  actual_input_tokens integer NOT NULL DEFAULT 0,
  actual_output_tokens integer NOT NULL DEFAULT 0,
  actual_total_tokens integer NOT NULL DEFAULT 0,
  model_call_id text REFERENCES model_calls(id),
  prompt_version text NOT NULL,
  validation_json text NOT NULL DEFAULT '{}',
  error_code text,
  error_message text,
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL,
  completed_at text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_rewrite_runs_workspace_created ON script_rewrite_runs (organization_id, project_id, workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_rewrite_runs_status_created ON script_rewrite_runs (status, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS script_rewrite_versions (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  workspace_id text NOT NULL REFERENCES script_rewrite_workspaces(id) ON DELETE CASCADE,
  version integer NOT NULL,
  variant text NOT NULL,
  parent_version_id text,
  run_id text REFERENCES script_rewrite_runs(id),
  text text NOT NULL,
  paragraphs_json text NOT NULL DEFAULT '[]',
  source_mapping_json text NOT NULL DEFAULT '[]',
  outline_json text NOT NULL DEFAULT '[]',
  validation_json text NOT NULL DEFAULT '{}',
  model_provider text,
  model_name text,
  prompt_version text,
  model_call_id text REFERENCES model_calls(id),
  change_summary text,
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_script_rewrite_versions_workspace_version ON script_rewrite_versions (workspace_id, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_rewrite_versions_scope_workspace ON script_rewrite_versions (organization_id, project_id, workspace_id, created_at);
