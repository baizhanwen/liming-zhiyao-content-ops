CREATE TABLE organization_tikhub_settings (
  organization_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL DEFAULT 1,
  encrypted_key TEXT,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
