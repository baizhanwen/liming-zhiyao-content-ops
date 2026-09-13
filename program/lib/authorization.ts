export const organizationRoles = ["admin", "member"] as const;
export const projectRoles = ["member"] as const;

export type OrganizationRole = (typeof organizationRoles)[number];
export type ProjectRole = (typeof projectRoles)[number];
export type AccessContext = { userId: string; organizationId: string; organizationRole: OrganizationRole; projectMemberships: ReadonlyMap<string, ProjectRole> };
export type ProjectResource = { organizationId: string; projectId: string };

export function canReadProject(context: AccessContext, resource: ProjectResource) {
  if (context.organizationId !== resource.organizationId) return false;
  if (context.organizationRole === "admin") return true;
  return context.projectMemberships.has(resource.projectId);
}

export function canWriteProject(context: AccessContext, resource: ProjectResource) {
  return canReadProject(context, resource);
}
