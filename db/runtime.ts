import { env } from "cloudflare:workers";
import type { RequestIdentity } from "../lib/request-auth";
import type { OrganizationRole, ProjectRole } from "../lib/authorization";

export type UserRow = { id: string; auth_subject: string; email: string; display_name: string | null };
export type OrganizationAccess = { userId: string; organizationId: string; organizationRole: OrganizationRole };
export type ProjectAccess = OrganizationAccess & { projectId: string; projectRole: ProjectRole | null };

export function getD1() {
  const runtimeEnv = env as typeof env & { DB?: D1Database };
  if (!runtimeEnv.DB) throw new Error("D1 binding DB is unavailable");
  return runtimeEnv.DB;
}

export function getMediaBucket() {
  const runtimeEnv = env as typeof env & { MEDIA?: R2Bucket };
  if (!runtimeEnv.MEDIA) throw new Error("R2 binding MEDIA is unavailable");
  return runtimeEnv.MEDIA;
}

export async function ensureUser(identity: RequestIdentity): Promise<UserRow> {
  const db = getD1();
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (id, auth_subject, email, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(auth_subject) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), identity.authSubject, identity.email, identity.displayName, now, now).run();

  const row = await db.prepare(`
    SELECT id, auth_subject, email, display_name
    FROM users
    WHERE auth_subject = ? AND status = 'active'
  `).bind(identity.authSubject).first<UserRow>();
  if (!row) throw new Error("Authenticated user is unavailable");
  return row;
}

export async function getOrganizationAccess(authSubject: string, organizationId: string): Promise<OrganizationAccess | null> {
  return getD1().prepare(`
    SELECT u.id AS userId, om.organization_id AS organizationId, om.role AS organizationRole
    FROM organization_members om
    INNER JOIN users u ON u.id = om.user_id
    INNER JOIN organizations o ON o.id = om.organization_id
    WHERE u.auth_subject = ?
      AND om.organization_id = ?
      AND u.status = 'active'
      AND om.status = 'active'
      AND o.status = 'active'
  `).bind(authSubject, organizationId).first<OrganizationAccess>();
}

export async function getProjectAccess(authSubject: string, organizationId: string, projectId: string): Promise<ProjectAccess | null> {
  const organization = await getOrganizationAccess(authSubject, organizationId);
  if (!organization) return null;

  const project = await getD1().prepare(`
    SELECT id FROM projects
    WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND status != 'archived'
  `).bind(projectId, organizationId).first<{ id: string }>();
  if (!project) return null;
  if (organization.organizationRole === "admin") return { ...organization, projectId, projectRole: null };

  const membership = await getD1().prepare(`
    SELECT role AS projectRole
    FROM project_members
    WHERE organization_id = ? AND project_id = ? AND user_id = ? AND status = 'active'
  `).bind(organizationId, projectId, organization.userId).first<{ projectRole: ProjectRole }>();
  return membership ? { ...organization, projectId, projectRole: membership.projectRole } : null;
}

export async function hashInvitationToken(token: string) {
  return sha256Hex(new TextEncoder().encode(token));
}

export async function sha256Hex(input: ArrayBuffer | ArrayBufferView) {
  const bytes = input instanceof ArrayBuffer
    ? input
    : Uint8Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)).buffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canWriteProjectAccess(access: ProjectAccess) {
  if (access.organizationRole === "admin") return true;
  return access.organizationRole !== "readonly" && access.projectRole !== null && !["reviewer", "client", "readonly"].includes(access.projectRole);
}

export async function canAccessOrganizationVideoLibrary(access: OrganizationAccess) {
  if (access.organizationRole === "admin") return true;
  if (access.organizationRole === "readonly") return false;
  const membership = await getD1().prepare(`
    SELECT 1 AS allowed
    FROM project_members pm
    INNER JOIN projects p ON p.id = pm.project_id AND p.organization_id = pm.organization_id
    WHERE pm.organization_id = ? AND pm.user_id = ? AND pm.status = 'active'
      AND pm.role IN ('owner', 'planner', 'creator', 'reviewer')
      AND p.deleted_at IS NULL AND p.status != 'archived'
    LIMIT 1
  `).bind(access.organizationId, access.userId).first<{ allowed: number }>();
  return Boolean(membership?.allowed);
}

export async function canManageOrganizationVideoLibrary(access: OrganizationAccess) {
  if (access.organizationRole === "admin") return true;
  if (access.organizationRole === "readonly") return false;
  const membership = await getD1().prepare(`
    SELECT 1 AS allowed
    FROM project_members pm
    INNER JOIN projects p ON p.id = pm.project_id AND p.organization_id = pm.organization_id
    WHERE pm.organization_id = ? AND pm.user_id = ? AND pm.status = 'active'
      AND pm.role IN ('owner', 'planner', 'creator')
      AND p.deleted_at IS NULL AND p.status != 'archived'
    LIMIT 1
  `).bind(access.organizationId, access.userId).first<{ allowed: number }>();
  return Boolean(membership?.allowed);
}

export function makeSlug(name: string, id: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "organization";
  return `${base}-${id.replaceAll("-", "").slice(0, 8)}`;
}
