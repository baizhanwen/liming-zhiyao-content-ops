import { env } from "cloudflare:workers";
import { locateMediaObject } from "../lib/media-object-store";
import type { RequestIdentity } from "../lib/request-auth";
import type { OrganizationRole, ProjectRole } from "../lib/authorization";
import { resolveProjectAccess } from "../lib/scope-access-state";

export type UserRow = { id: string; auth_subject: string; email: string; display_name: string | null };
export type OrganizationAccess = { userId: string; organizationId: string; organizationRole: OrganizationRole };
export type ProjectAccess = OrganizationAccess & { projectId: string; projectRole: ProjectRole | null };

export function getD1() {
  const runtimeEnv = env as typeof env & { DB?: D1Database };
  if (!runtimeEnv.DB) throw new Error("D1 binding DB is unavailable");
  return runtimeEnv.DB;
}

type MediaRuntimeEnv = typeof env & {
  MEDIA?: R2Bucket;
  MEDIA_LEGACY?: R2Bucket;
};

export function getMediaBucket() {
  const runtimeEnv = env as MediaRuntimeEnv;
  if (!runtimeEnv.MEDIA) throw new Error("R2 binding MEDIA is unavailable");
  return runtimeEnv.MEDIA;
}

export function getLegacyMediaBucket() {
  return (env as MediaRuntimeEnv).MEDIA_LEGACY ?? null;
}

export async function getMediaObject(key: string, options?: R2GetOptions) {
  const located = await locateMediaObject(getMediaBucket(), getLegacyMediaBucket(), key, options);
  if (located?.source === "legacy") {
    console.info("media_object_legacy_fallback", { key });
  }
  return located;
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
  const row = await getD1().prepare(`
    SELECT u.id AS userId, om.organization_id AS organizationId, om.role AS organizationRole,
      p.id AS projectId, pm.role AS projectRole
    FROM organization_members om
    INNER JOIN users u ON u.id = om.user_id
    INNER JOIN organizations o ON o.id = om.organization_id
    INNER JOIN projects p ON p.id = ? AND p.organization_id = om.organization_id AND p.deleted_at IS NULL AND p.status != 'archived'
    LEFT JOIN project_members pm ON pm.organization_id = p.organization_id AND pm.project_id = ? AND pm.project_id = p.id AND pm.user_id = u.id AND pm.status = 'active'
    WHERE u.auth_subject = ?
      AND om.organization_id = ?
      AND u.status = 'active'
      AND om.status = 'active'
      AND o.status = 'active'
  `).bind(projectId, projectId, authSubject, organizationId).first<ProjectAccess>();
  if (!row) return null;
  const organization = { organizationRole: row.organizationRole };
  if (organization.organizationRole === "admin") return { ...row, projectRole: null };
  return resolveProjectAccess(row);
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
  return access.organizationRole === "admin" || access.projectRole !== null;
}

export async function canAccessOrganizationVideoLibrary(access: OrganizationAccess) {
  if (access.organizationRole === "admin") return true;
  const membership = await getD1().prepare(`
    SELECT 1 AS allowed
    FROM project_members pm
    INNER JOIN projects p ON p.id = pm.project_id AND p.organization_id = pm.organization_id
    WHERE pm.organization_id = ? AND pm.user_id = ? AND pm.status = 'active'
      AND p.deleted_at IS NULL AND p.status != 'archived'
    LIMIT 1
  `).bind(access.organizationId, access.userId).first<{ allowed: number }>();
  return Boolean(membership?.allowed);
}

export async function canManageOrganizationVideoLibrary(access: OrganizationAccess) {
  return canAccessOrganizationVideoLibrary(access);
}

export function makeSlug(name: string, id: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "organization";
  return `${base}-${id.replaceAll("-", "").slice(0, 8)}`;
}
