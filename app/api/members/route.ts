import { ensureUser, getD1, getOrganizationAccess, hashInvitationToken } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { organizationRoles, projectRoles } from "../../../lib/authorization";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问成员数据。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的成员。", 403);
    if (access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以查看公司级成员与邀请。", 403);
    const db = getD1();
    const [members, invitations] = await Promise.all([
      db.prepare(`SELECT u.id, u.email, u.display_name, om.role, om.status, om.created_at FROM organization_members om INNER JOIN users u ON u.id = om.user_id WHERE om.organization_id = ? AND om.status != 'removed' ORDER BY om.created_at ASC`).bind(organizationId).all(),
      db.prepare(`SELECT id, email, organization_role, project_id, project_role, status, expires_at, created_at FROM invitations WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC`).bind(organizationId).all(),
    ]);
    return Response.json({ members: members.results, invitations: invitations.results, organizationRole: access.organizationRole });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再邀请成员。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; email?: string; organizationRole?: string; projectId?: string; projectRole?: string };
    const organizationId = payload.organizationId?.trim() ?? "";
    const email = payload.email?.trim().toLowerCase() ?? "";
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError("INVALID_EMAIL", "请输入有效邮箱地址。", 400);
    if (!organizationRoles.includes(payload.organizationRole as never)) return apiError("INVALID_ORGANIZATION_ROLE", "公司角色无效。", 400);
    const projectId = payload.projectId?.trim() || null;
    const projectRole = projectId ? payload.projectRole?.trim() || null : null;
    if (projectId && !projectRole) return apiError("PROJECT_ROLE_REQUIRED", "分配项目时必须选择项目角色。", 400);
    if (projectRole && !projectRoles.includes(projectRole as never)) return apiError("INVALID_PROJECT_ROLE", "项目角色无效。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以邀请成员。", 403);
    const db = getD1();
    if (projectId) {
      const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL").bind(projectId, organizationId).first();
      if (!project) return apiError("PROJECT_NOT_FOUND", "指定项目不存在。", 404);
    }
    const user = await ensureUser(identity);
    const invitationId = crypto.randomUUID();
    const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = await hashInvitationToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.batch([
      db.prepare("INSERT INTO invitations (id, organization_id, project_id, email, organization_role, project_role, token_hash, status, expires_at, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(invitationId, organizationId, projectId, email, payload.organizationRole, projectRole, tokenHash, expiresAt, user.id, user.id, now.toISOString(), now.toISOString()),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'invitation.created', 'invitation', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, invitationId, JSON.stringify({ email, organizationRole: payload.organizationRole, projectRole }), now.toISOString()),
    ]);
    return Response.json({ invitation: { id: invitationId, email, status: "pending", expires_at: expiresAt, accept_url: `/accept-invitation?token=${token}` } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
