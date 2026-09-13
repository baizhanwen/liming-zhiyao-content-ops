CREATE TABLE IF NOT EXISTS project_inspiration_cards (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  canonical_key text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'candidate',
  title text NOT NULL,
  core_insight text NOT NULL,
  applicable_scenarios_json text NOT NULL DEFAULT '[]',
  excluded_scenarios_json text NOT NULL DEFAULT '[]',
  evidence_json text NOT NULL DEFAULT '[]',
  source_type text NOT NULL,
  source_id text,
  tags_json text NOT NULL DEFAULT '[]',
  confidence integer,
  content_hash text NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  confirmed_by text REFERENCES users(id),
  confirmed_at text,
  rejected_by text REFERENCES users(id),
  rejected_at text,
  superseded_by text,
  expires_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspiration_cards_scope_key_version ON project_inspiration_cards (organization_id, project_id, canonical_key, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inspiration_cards_scope_status_updated ON project_inspiration_cards (organization_id, project_id, status, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inspiration_cards_source ON project_inspiration_cards (organization_id, source_type, source_id);