CREATE TABLE IF NOT EXISTS project_memory_events (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  event_type text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  dedupe_key text NOT NULL,
  payload_json text NOT NULL DEFAULT '{}',
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  operation_summary_json text NOT NULL DEFAULT '[]',
  attempt_count integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  model_provider text,
  model_name text,
  prompt_version text,
  created_by text NOT NULL REFERENCES users(id),
  processed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_events_dedupe ON project_memory_events (organization_id, project_id, dedupe_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_memory_events_scope_status ON project_memory_events (organization_id, project_id, status, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_assistant_conversations (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_assistant_conversations_scope_updated ON project_assistant_conversations (organization_id, project_id, status, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_assistant_messages (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  conversation_id text NOT NULL REFERENCES project_assistant_conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  content text NOT NULL,
  suggestions_json text NOT NULL DEFAULT '[]',
  citations_json text NOT NULL DEFAULT '[]',
  memory_operations_json text NOT NULL DEFAULT '[]',
  model_provider text,
  model_name text,
  prompt_version text,
  error_code text,
  created_by text NOT NULL REFERENCES users(id),
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_assistant_messages_conversation_created ON project_assistant_messages (conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_assistant_messages_scope_created ON project_assistant_messages (organization_id, project_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_inspiration_card_sources (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id),
  project_id text NOT NULL REFERENCES projects(id),
  card_id text NOT NULL REFERENCES project_inspiration_cards(id) ON DELETE CASCADE,
  conversation_id text REFERENCES project_assistant_conversations(id),
  message_id text REFERENCES project_assistant_messages(id),
  memory_item_id text REFERENCES project_memory_items(id),
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspiration_card_sources_unique ON project_inspiration_card_sources (card_id, message_id, memory_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inspiration_card_sources_scope ON project_inspiration_card_sources (organization_id, project_id, card_id);
