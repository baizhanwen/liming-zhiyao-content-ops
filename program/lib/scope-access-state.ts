import type { OrganizationRole, ProjectRole } from "./authorization";

export type ProjectAccessRow = {
  userId: string;
  organizationId: string;
  organizationRole: OrganizationRole;
  projectId: string;
  projectRole: ProjectRole | null;
};

export function resolveProjectAccess(row: ProjectAccessRow | null) {
  if (!row) return null;
  if (row.organizationRole === "admin") return { ...row, projectRole: null };
  return row.projectRole ? row : null;
}