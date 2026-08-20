UPDATE `organization_members` SET `role` = 'member' WHERE `role` = 'readonly';
--> statement-breakpoint
UPDATE `invitations` SET `organization_role` = 'member' WHERE `organization_role` = 'readonly' AND `status` = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organization_one_active_admin` ON `organization_members` (`organization_id`) WHERE `role` = 'admin' AND `status` = 'active';
