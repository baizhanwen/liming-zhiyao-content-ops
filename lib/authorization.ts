export const organizationRoles = ["admin", "member"] as const;
export const projectRoles = ["owner", "planner", "creator", "reviewer", "client", "readonly"] as const;

/** `readonly` remains in the type for forward-compatible reads of an older database; new writes never accept it. */
export type OrganizationRole = (typeof organizationRoles)[number] | "readonly";
export type ProjectRole = (typeof projectRoles)[number];
export type AccessContext = { userId: string; organizationId: string; organizationRole: OrganizationRole; projectMemberships: ReadonlyMap<string, ProjectRole> };
export type ProjectResource = { organizationId: string; projectId: string };

export function canReadProject(context: AccessContext, resource: ProjectResource) {
  if (context.organizationId !== resource.organizationId) return false;
  if (context.organizationRole === "admin") return true;
  return context.projectMemberships.has(resource.projectId);
}

export function canWriteProject(context: AccessContext, resource: ProjectResource) {
  if (!canReadProject(context, resource) || context.organizationRole === "readonly") return false;
  const role = context.projectMemberships.get(resource.projectId);
  return context.organizationRole === "admin" || (role !== undefined && role !== "client" && role !== "readonly");
}

export function canReviewContent(context: AccessContext, resource: ProjectResource) {
  if (!canReadProject(context, resource)) return false;
  const role = context.projectMemberships.get(resource.projectId);
  return context.organizationRole === "admin" || role === "owner" || role === "reviewer" || role === "client";
}

export function assertProjectAccess(context: AccessContext, resource: ProjectResource) {
  if (!canReadProject(context, resource)) throw new Error("PROJECT_ACCESS_DENIED");
  return { organizationId: context.organizationId, projectId: resource.projectId };
}
