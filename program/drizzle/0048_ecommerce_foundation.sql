-- Additive ecommerce storage. Existing content/topic/workflow tables are untouched.
CREATE TABLE ecommerce_project_settings (
  organization_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT NOT NULL REFERENCES projects(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrent BETWEEN 1 AND 3),
  monthly_call_limit INTEGER NOT NULL DEFAULT 100 CHECK(monthly_call_limit BETWEEN 1 AND 10000),
  updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, project_id)
);

CREATE TABLE ecommerce_products (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT NOT NULL REFERENCES projects(id),
  sku TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','confirmed','revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), current_version INTEGER NOT NULL DEFAULT 1 CHECK(current_version > 0),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(organization_id,project_id,sku), UNIQUE(id,organization_id,project_id)
);
CREATE TABLE ecommerce_product_versions (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, product_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), name TEXT NOT NULL, sku TEXT NOT NULL,
  public_json TEXT NOT NULL CHECK(json_valid(public_json)), internal_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(internal_json)),
  confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  FOREIGN KEY(product_id,organization_id,project_id) REFERENCES ecommerce_products(id,organization_id,project_id),
  UNIQUE(product_id,version), UNIQUE(id,organization_id,project_id), UNIQUE(id,product_id,organization_id,project_id)
);
CREATE TABLE ecommerce_evidence (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, product_id TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), content_hash TEXT NOT NULL,
  media_asset_id TEXT REFERENCES media_assets(id), valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','confirmed','revoked')), revision INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(product_id,organization_id,project_id) REFERENCES ecommerce_products(id,organization_id,project_id),
  UNIQUE(id,organization_id,project_id)
);

CREATE TABLE ecommerce_components (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT REFERENCES organizations(id), project_id TEXT REFERENCES projects(id),
  scope TEXT NOT NULL CHECK(scope IN ('system','project')), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('hook','visual','structure','sop')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','confirmed','revoked')), revision INTEGER NOT NULL DEFAULT 1,
  current_version INTEGER NOT NULL DEFAULT 1, source_key TEXT NOT NULL,
  created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((scope='system' AND organization_id IS NULL AND project_id IS NULL) OR (scope='project' AND organization_id IS NOT NULL AND project_id IS NOT NULL)),
  UNIQUE(organization_id,project_id,source_key)
);
CREATE UNIQUE INDEX idx_ecommerce_system_component_source ON ecommerce_components(source_key) WHERE scope='system';
CREATE TABLE ecommerce_component_versions (
  id TEXT PRIMARY KEY NOT NULL, component_id TEXT NOT NULL REFERENCES ecommerce_components(id), version INTEGER NOT NULL,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), content_hash TEXT NOT NULL,
  confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(component_id,version)
);
CREATE TABLE ecommerce_case_profiles (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id), project_id TEXT NOT NULL REFERENCES projects(id),
  reference_id TEXT NOT NULL REFERENCES project_video_references(id), video_id TEXT NOT NULL REFERENCES videos(id),
  analysis_id TEXT NOT NULL REFERENCES video_analyses(id), transcript_id TEXT REFERENCES video_transcripts(id),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), source_snapshot TEXT NOT NULL, content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','confirmed','revoked')), revision INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(organization_id,project_id,reference_id,analysis_id), UNIQUE(id,organization_id,project_id)
);

CREATE TABLE ecommerce_tasks (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  product_id TEXT NOT NULL, product_version_id TEXT NOT NULL, title TEXT NOT NULL,
  brief_json TEXT NOT NULL CHECK(json_valid(brief_json)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','internal_review','publish_ready','published','reviewed','archived')),
  created_by TEXT NOT NULL REFERENCES users(id), updated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(product_id,organization_id,project_id) REFERENCES ecommerce_products(id,organization_id,project_id),
  FOREIGN KEY(product_version_id,product_id,organization_id,project_id) REFERENCES ecommerce_product_versions(id,product_id,organization_id,project_id),
  UNIQUE(id,organization_id,project_id)
);
CREATE TABLE ecommerce_generation_runs (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, base_version INTEGER NOT NULL, task_revision INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('generate','hook','evidence','cta')), status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  call_count INTEGER NOT NULL DEFAULT 0 CHECK(call_count BETWEEN 0 AND 5), result_version_id TEXT,
  error_code TEXT, error_message TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, completed_at TEXT,
  FOREIGN KEY(task_id,organization_id,project_id) REFERENCES ecommerce_tasks(id,organization_id,project_id),
  UNIQUE(organization_id,project_id,idempotency_key), UNIQUE(id,organization_id,project_id)
);
CREATE UNIQUE INDEX idx_ecommerce_running_task ON ecommerce_generation_runs(task_id) WHERE status='running';
CREATE TABLE ecommerce_versions (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  product_id TEXT NOT NULL, product_version_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
  parent_version_id TEXT REFERENCES ecommerce_versions(id), run_id TEXT REFERENCES ecommerce_generation_runs(id),
  mode TEXT NOT NULL CHECK(mode IN ('ai','manual','patch')), pack_json TEXT NOT NULL CHECK(json_valid(pack_json)),
  input_snapshot_json TEXT NOT NULL CHECK(json_valid(input_snapshot_json)), input_hash TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL CHECK(json_valid(source_manifest_json)), validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
  change_summary TEXT NOT NULL, prompt_version TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  FOREIGN KEY(task_id,organization_id,project_id) REFERENCES ecommerce_tasks(id,organization_id,project_id),
  FOREIGN KEY(product_version_id,product_id,organization_id,project_id) REFERENCES ecommerce_product_versions(id,product_id,organization_id,project_id),
  UNIQUE(task_id,version), UNIQUE(id,organization_id,project_id), UNIQUE(id,task_id,organization_id,project_id)
);
CREATE TABLE ecommerce_reviews (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, version_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('submitted','approved','changes_requested')), note TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  FOREIGN KEY(version_id,task_id,organization_id,project_id) REFERENCES ecommerce_versions(id,task_id,organization_id,project_id)
);
CREATE TABLE ecommerce_publications (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, version_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES social_accounts(id), platform TEXT NOT NULL, external_id TEXT NOT NULL DEFAULT '', external_url TEXT NOT NULL,
  published_at TEXT NOT NULL, traffic TEXT NOT NULL CHECK(traffic IN ('organic','paid')), ad_plan TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  FOREIGN KEY(version_id,task_id,organization_id,project_id) REFERENCES ecommerce_versions(id,task_id,organization_id,project_id),
  UNIQUE(organization_id,project_id,platform,external_url), UNIQUE(id,organization_id,project_id)
);
CREATE TABLE ecommerce_metric_snapshots (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, publication_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, attribution_scope TEXT NOT NULL CHECK(attribution_scope IN ('video','product','live')),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), content_hash TEXT NOT NULL, replaces_id TEXT REFERENCES ecommerce_metric_snapshots(id),
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  FOREIGN KEY(publication_id,organization_id,project_id) REFERENCES ecommerce_publications(id,organization_id,project_id),
  UNIQUE(publication_id,content_hash), UNIQUE(replaces_id)
);
CREATE INDEX idx_ecommerce_products_scope ON ecommerce_products(organization_id,project_id,status,updated_at);
CREATE INDEX idx_ecommerce_evidence_product ON ecommerce_evidence(organization_id,project_id,product_id,status);
CREATE INDEX idx_ecommerce_components_scope ON ecommerce_components(organization_id,project_id,status,kind);
CREATE INDEX idx_ecommerce_cases_scope ON ecommerce_case_profiles(organization_id,project_id,status);
CREATE INDEX idx_ecommerce_tasks_scope ON ecommerce_tasks(organization_id,project_id,status,updated_at);
CREATE INDEX idx_ecommerce_runs_scope ON ecommerce_generation_runs(organization_id,project_id,status,created_at);
CREATE INDEX idx_ecommerce_reviews_version ON ecommerce_reviews(version_id,created_at);
CREATE INDEX idx_ecommerce_publications_scope ON ecommerce_publications(organization_id,project_id,task_id,published_at);
CREATE INDEX idx_ecommerce_metrics_publication ON ecommerce_metric_snapshots(publication_id,observed_at);

CREATE TRIGGER ecommerce_product_version_immutable BEFORE UPDATE ON ecommerce_product_versions BEGIN SELECT RAISE(ABORT,'Product versions are immutable'); END;
CREATE TRIGGER ecommerce_component_version_immutable BEFORE UPDATE ON ecommerce_component_versions BEGIN SELECT RAISE(ABORT,'Component versions are immutable'); END;
CREATE TRIGGER ecommerce_version_immutable BEFORE UPDATE ON ecommerce_versions BEGIN SELECT RAISE(ABORT,'Content versions are immutable'); END;
CREATE TRIGGER ecommerce_publication_immutable BEFORE UPDATE ON ecommerce_publications BEGIN SELECT RAISE(ABORT,'Published versions cannot be rebound'); END;
CREATE TRIGGER ecommerce_metrics_immutable BEFORE UPDATE ON ecommerce_metric_snapshots BEGIN SELECT RAISE(ABORT,'Append a correction snapshot'); END;
