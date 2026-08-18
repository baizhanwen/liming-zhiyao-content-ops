import { getD1, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { isProjectRoleCompatible, organizationRoles, projectRoles } from "../../../../lib/authorization";
import { createLocalSession, setLocalPassword, validateLocalPassword } from "../../../../lib/local-auth";

type InvitationRow = { id: string; organization_id: string; project_id: string | null; email: string; organization_role: string; project_role: string | null; status: string; expires_at: string };

export async function POST(request: Request) {
  try {
    const payload = await request.json() as { token?: string; displayName?: string; password?: string; confirmation?: string };
    const token = payload.token?.trim() ?? "";
    if (token.length < 32) return apiError("INVALID_TOKEN", "邀请链接无效。", 400);
    const displayName = payload.displayName?.trim() ?? "";
    if (displayName.length < 2 || displayName.length > 40) return apiError("INVALID_NAME", "姓名需要 2 至 40 个字符。", 400);
    const password = payload.password ?? "";
    const invalidPassword = validateLocalPassword(password);
    if (invalidPassword) return apiError("INVALID_PASSWORD", invalidPassword, 400);
    if (password !== payload.confirmation) return apiError("PASSWORD_MISMATCH", "两次输入的密码不一致。", 400);
    const db = getD1();
    const invitation = await db.prepare("SELECT id, organization_id, project_id, email, organization_role, project_role, status, expires_at FROM invitations WHERE token_hash = ?").bind(await hashInvitationToken(token)).first<InvitationRow>();
    if (!invitation || invitation.status !== "pending") return apiError("INVITATION_UNAVAILABLE", "邀请不存在或已使用。", 404);
    if (new Date(invitation.expires_at).getTime() <= Date.now()) return apiError("INVITATION_EXPIRED", "邀请已经过期，请联系管理员重新发送。", 410);
    if (!organizationRoles.includes(invitation.organization_role as never) || (invitation.project_role && !projectRoles.includes(invitation.project_role as never))) return apiError("INVITATION_ROLE_INVALID", "邀请中的权限设置已失效，请联系管理员重新发送。", 409);
    if (!isProjectRoleCompatible(invitation.organization_role as (typeof organizationRoles)[number], invitation.project_role as (typeof projectRoles)[number] | null)) return apiError("INVITATION_ROLE_INVALID", "邀请中的公司角色与项目角色不兼容，请联系管理员重新发送。", 409);
    const now = new Date().toISOString();
    let user = await db.prepare("SELECT id, email FROM users WHERE lower(email) = ? AND status = 'active'").bind(invitation.email.toLowerCase()).first<{ id: string; email: string }>();
    if (user) {
      const existingMembership = await db.prepare("SELECT status FROM organization_members WHERE organization_id = ? AND user_id = ? AND status != 'removed'").bind(invitation.organization_id, user.id).first<{ status: string }>();
      if (existingMembership) return apiError("MEMBER_ALREADY_EXISTS", "你已经是该公司成员，请直接登录；如需调整项目，请联系管理员。", 409);
    }
    if (invitation.project_id) {
      const project = await db.prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND status != 'archived'").bind(invitation.project_id, invitation.organization_id).first<{ id: string }>();
      if (!project) return apiError("INVITATION_PROJECT_UNAVAILABLE", "邀请关联的客户项目已归档或删除，请联系管理员重新发送。", 409);
    }
    if (!user) {
      user = { id: crypto.randomUUID(), email: invitation.email.toLowerCase() };
      await db.prepare("INSERT INTO users (id, auth_subject, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .bind(user.id, `lan:${crypto.randomUUID()}`, user.email, displayName, now, now).run();
    } else {
      await db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").bind(displayName, now, user.id).run();
    }
    await setLocalPassword(user.id, password);
    const statements = [
      db.prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(crypto.randomUUID(), invitation.organization_id, user.id, invitation.organization_role, user.id, user.id, now, now),
      db.prepare("UPDATE invitations SET status = 'accepted', accepted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, user.id, now, invitation.id),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'invitation.accepted', 'invitation', ?, ?, ?)").bind(crypto.randomUUID(), invitation.organization_id, invitation.project_id, user.id, invitation.id, JSON.stringify({ email: user.email }), now),
    ];
    if (invitation.project_id && invitation.project_role) statements.splice(1, 0, db.prepare(`INSERT INTO project_members (id, organization_id, project_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(crypto.randomUUID(), invitation.organization_id, invitation.project_id, user.id, invitation.project_role, user.id, user.id, now, now));
    await db.batch(statements);
    return Response.json({ accepted: true, organizationId: invitation.organization_id, projectId: invitation.project_id }, { headers: { "set-cookie": await createLocalSession(user.id, request), "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
