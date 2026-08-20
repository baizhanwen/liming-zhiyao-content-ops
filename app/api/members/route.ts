import { env } from "cloudflare:workers";
import { ensureUser, getD1, getOrganizationAccess, hashInvitationToken } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { organizationRoles, projectRoles } from "../../../lib/authorization";
import { readRequestIdentity } from "../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../lib/operations";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
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
    return Response.json({ members: members.results, invitations: invitations.results, organizationRole: access.organizationRole, currentUserId: access.userId });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再管理成员。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; memberId?: string; invitationId?: string; role?: string; status?: string };
    const organizationId = payload.organizationId?.trim() ?? "";
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以管理成员。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    if (payload.invitationId) {
      const result = await db.prepare("UPDATE invitations SET status = 'revoked', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'pending'").bind(user.id, now, payload.invitationId, organizationId).run();
      if (!result.meta.changes) return apiError("INVITATION_NOT_PENDING", "邀请不存在或已经处理。", 409);
      await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, NULL, ?, 'invitation.revoked', 'invitation', ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, payload.invitationId, now).run();
      return Response.json({ invitation: { id: payload.invitationId, status: "revoked" } });
    }
    const memberId = payload.memberId?.trim() ?? "";
    if (!memberId || !organizationRoles.includes(payload.role as never) || !["active", "suspended", "removed"].includes(payload.status ?? "")) return apiError("INVALID_MEMBER_UPDATE", "成员角色或状态无效。公司成员身份只能是管理员或员工。", 400);
    const target = await db.prepare("SELECT role, status FROM organization_members WHERE organization_id = ? AND user_id = ? AND status != 'removed'").bind(organizationId, memberId).first<{ role: string; status: string }>();
    if (!target) return apiError("MEMBER_NOT_FOUND", "成员不存在。", 404);
    if (target.role !== "admin" && payload.role === "admin") return apiError("ADMIN_ROLE_NOT_TRANSFERABLE", "公司管理员身份不可转让；后续成员只能是公司员工。", 409);
    if (memberId === access.userId && payload.status !== "active") return apiError("CANNOT_DISABLE_SELF", "管理员不能暂停或移除自己。", 409);
    if (target.role === "admin" && (payload.role !== "admin" || payload.status !== "active")) {
      const admins = await db.prepare("SELECT COUNT(*) AS value FROM organization_members WHERE organization_id = ? AND role = 'admin' AND status = 'active'").bind(organizationId).first<{ value: number }>();
      if ((admins?.value ?? 0) <= 1) return apiError("LAST_ADMIN_REQUIRED", "公司必须保留至少一位有效管理员。", 409);
    }
    const statements = [
      db.prepare("UPDATE organization_members SET role = ?, status = ?, updated_by = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?").bind(payload.role, payload.status, user.id, now, organizationId, memberId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'organization.member_updated', 'user', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, memberId, JSON.stringify({ previousRole: target.role, previousStatus: target.status, role: payload.role, status: payload.status, projectAccessRemoved: payload.status === "removed" }), now),
    ];
    if (payload.status === "removed") statements.splice(1, 0, db.prepare("UPDATE project_members SET status = 'removed', updated_by = ?, updated_at = ? WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(user.id, now, organizationId, memberId));
    await db.batch(statements);
    return Response.json({ member: { id: memberId, role: payload.role, status: payload.status }, projectAccessRemoved: payload.status === "removed" });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再邀请成员。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; email?: string; organizationRole?: string; projectId?: string; projectRole?: string };
    const organizationId = payload.organizationId?.trim() ?? "";
    const email = payload.email?.trim().toLowerCase() ?? "";
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError("INVALID_EMAIL", "请输入有效邮箱地址。", 400);
    if (payload.organizationRole !== "member") return apiError("INVALID_ORGANIZATION_ROLE", "公司管理员只能在首次开通时创建；后续邀请只能添加公司员工。", 400);
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
    const quota = await checkOrganizationQuota(organizationId, user.id, "members");
    if (!quota.allowed) return apiError("MEMBER_QUOTA_EXCEEDED", `当前套餐最多允许 ${quota.limit} 位有效成员。`, 429, { usage: quota.current, limit: quota.limit });
    const invitationId = crypto.randomUUID();
    const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = await hashInvitationToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.batch([
      db.prepare("INSERT INTO invitations (id, organization_id, project_id, email, organization_role, project_role, token_hash, status, expires_at, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)").bind(invitationId, organizationId, projectId, email, payload.organizationRole, projectRole, tokenHash, expiresAt, user.id, user.id, now.toISOString(), now.toISOString()),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'invitation.created', 'invitation', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, invitationId, JSON.stringify({ email, organizationRole: payload.organizationRole, projectRole }), now.toISOString()),
    ]);
    const relativeAcceptUrl = `/accept-invitation?token=${token}`;
    const configuredOrigin = ((env as typeof env & { LAN_ACCESS_ORIGIN?: string }).LAN_ACCESS_ORIGIN ?? "").trim().replace(/\/$/u, "");
    return Response.json({ invitation: { id: invitationId, email, status: "pending", expires_at: expiresAt, accept_url: configuredOrigin ? `${configuredOrigin}${relativeAcceptUrl}` : relativeAcceptUrl } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
