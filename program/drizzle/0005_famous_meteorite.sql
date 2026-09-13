CREATE TABLE `content_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`citation_type` text NOT NULL,
	`citation_id` text NOT NULL,
	`quote` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_citations_version_source` ON `content_citations` (`content_version_id`,`citation_type`,`citation_id`);--> statement-breakpoint
CREATE INDEX `idx_content_citations_tenant_item` ON `content_citations` (`organization_id`,`project_id`,`content_item_id`);--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`assignee_user_id` text,
	`due_at` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`) REFERENCES `topic_ideas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_items_topic` ON `content_items` (`topic_id`);--> statement-breakpoint
CREATE INDEX `idx_content_items_project_status_updated` ON `content_items` (`organization_id`,`project_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `content_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`version` integer NOT NULL,
	`generation_mode` text NOT NULL,
	`pack_json` text NOT NULL,
	`full_script` text NOT NULL,
	`short_script` text NOT NULL,
	`change_summary` text,
	`prompt_version` text,
	`model_call_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_call_id`) REFERENCES `model_calls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_versions_item_version` ON `content_versions` (`content_item_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_content_versions_tenant_item` ON `content_versions` (`organization_id`,`project_id`,`content_item_id`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`topic_id` text,
	`prompt_template_id` text,
	`task_type` text NOT NULL,
	`provider` text NOT NULL,
	`model_name` text NOT NULL,
	`model_profile` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`latency_ms` integer,
	`error_code` text,
	`error_message` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`) REFERENCES `topic_ideas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_template_id`) REFERENCES `prompt_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_model_calls_project_created` ON `model_calls` (`organization_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_model_calls_topic_created` ON `model_calls` (`topic_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_type` text NOT NULL,
	`version` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`system_prompt` text NOT NULL,
	`output_schema_json` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prompt_templates_project_task_version` ON `prompt_templates` (`project_id`,`task_type`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_prompt_templates_one_active` ON `prompt_templates` (`organization_id`,`project_id`,`task_type`) WHERE "prompt_templates"."status" = 'active';--> statement-breakpoint
PRAGMA optimize;
