CREATE TABLE `authorized_knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`revision` text NOT NULL,
	`item_count` integer NOT NULL DEFAULT 0,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `authorized_knowledge_atoms` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`knowledge` text NOT NULL,
	`original` text NOT NULL,
	`url` text,
	`published_at` text,
	`topics_json` text NOT NULL DEFAULT '[]',
	`skills_json` text NOT NULL DEFAULT '[]',
	`atom_type` text NOT NULL,
	`confidence` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `authorized_knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_authorized_atoms_source_confidence` ON `authorized_knowledge_atoms` (`source_id`,`confidence`);
--> statement-breakpoint
CREATE INDEX `idx_authorized_atoms_type_date` ON `authorized_knowledge_atoms` (`atom_type`,`published_at`);
