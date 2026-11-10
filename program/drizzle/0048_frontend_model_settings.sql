CREATE TABLE organization_model_settings (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
