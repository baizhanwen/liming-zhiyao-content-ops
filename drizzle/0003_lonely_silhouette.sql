CREATE TABLE `content_strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`positioning` text NOT NULL,
	`persona` text,
	`target_audience` text NOT NULL,
	`pain_points_json` text NOT NULL,
	`pillars_json` text NOT NULL,
	`topic_mix_json` text NOT NULL,
	`style_notes` text,
	`cadence` text,
	`conversion_path` text,
	`objectives_json` text NOT NULL,
	`effective_from` text,
	`effective_to` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_strategies_project_version` ON `content_strategies` (`project_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_strategies_one_active` ON `content_strategies` (`organization_id`,`project_id`) WHERE "content_strategies"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_content_strategies_project_status` ON `content_strategies` (`organization_id`,`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `knowledge_item_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`change_summary` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `knowledge_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_versions_item_version` ON `knowledge_item_versions` (`item_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_versions_tenant_item` ON `knowledge_item_versions` (`organization_id`,`project_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `knowledge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`confirmed_by` text,
	`confirmed_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_items_project_status_category` ON `knowledge_items` (`organization_id`,`project_id`,`status`,`category`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_items_project_updated` ON `knowledge_items` (`organization_id`,`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `topic_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`citation_type` text NOT NULL,
	`citation_id` text NOT NULL,
	`quote` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`) REFERENCES `topic_ideas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_topic_citations_topic_source` ON `topic_citations` (`topic_id`,`citation_type`,`citation_id`);--> statement-breakpoint
CREATE INDEX `idx_topic_citations_tenant_topic` ON `topic_citations` (`organization_id`,`project_id`,`topic_id`);--> statement-breakpoint
CREATE TABLE `topic_ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`angle` text,
	`source_type` text NOT NULL,
	`source_ref` text,
	`pillar` text,
	`audience` text,
	`objective` text,
	`hook` text,
	`rationale` text,
	`priority` integer DEFAULT 50 NOT NULL,
	`status` text DEFAULT 'idea' NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_topic_ideas_project_status_priority` ON `topic_ideas` (`organization_id`,`project_id`,`status`,`priority`);--> statement-breakpoint
CREATE INDEX `idx_topic_ideas_project_created` ON `topic_ideas` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
