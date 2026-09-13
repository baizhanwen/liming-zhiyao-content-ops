ALTER TABLE topic_ideas ADD COLUMN source_manifest_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE topic_ideas ADD COLUMN missing_context_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE topic_ideas ADD COLUMN risk_notes_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE topic_ideas ADD COLUMN context_snapshot_id text;
--> statement-breakpoint
ALTER TABLE content_versions ADD COLUMN input_snapshot_json text;
--> statement-breakpoint
ALTER TABLE content_versions ADD COLUMN input_snapshot_hash text;
--> statement-breakpoint
ALTER TABLE content_versions ADD COLUMN source_manifest_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE content_versions ADD COLUMN context_snapshot_id text;