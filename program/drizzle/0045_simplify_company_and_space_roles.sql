-- The product has exactly two company roles: one administrator and employees.
-- Enterprise-space access is binary; every assigned employee has the same
-- complete set of business permissions inside that space.
UPDATE organization_members
SET role = 'member'
WHERE role != 'admin';

UPDATE project_members
SET role = 'member'
WHERE role != 'member';

UPDATE invitations
SET organization_role = 'member',
    project_role = CASE WHEN project_id IS NULL THEN NULL ELSE 'member' END
WHERE status = 'pending';
