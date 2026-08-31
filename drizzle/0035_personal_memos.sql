CREATE TABLE personal_memos (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'performance_report')),
  source_id TEXT,
  source_locator TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_personal_memos_owner_status ON personal_memos (organization_id, owner_user_id, status, updated_at);
CREATE UNIQUE INDEX idx_personal_memos_source_once ON personal_memos (owner_user_id, source_type, source_id, source_locator);
