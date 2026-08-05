import { ensureUser, getD1, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

type InvitationRow = { id: string; organization_id: string; project_id: string | null; email: string; organization_role: string; project_role: string | null; status: string; expires_at: string };

export async function POST(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再接受邀请。", 401);
  try {
    const payload = await request.json() as { token?: string };
    const token = payload.token?.trim() ?? "";
    if (token.length < 32) return apiError("INVALID_TOKEN", "邀请链接无效。", 400);
    const db = getD1();
    const invitation = await db.prepare("SELECT id, organization_id, project_id, email, organization_role, project_role, status, expires_at FROM invitations WHERE token_hash = ?").bind(await hashInvitationToken(token)).first<InvitationRow>();
    if (!invitation || invitation.status !== "pending") return apiError("INVITATION_UNAVAILABLE", "邀请不存在或已使用。", 404);
    if (new Date(invitation.expires_at).getTime() <= Date.now()) return apiError("INVITATION_EXPIRED", "邀请已经过期，请联系管理员重新发送。", 410);
    if (invitation.email.toLowerCase() !== identity.email) return apiError("EMAIL_MISMATCH", "请使用收到邀请的邮箱登录。", 403);
    const user = await ensureUser(identity);
    const now = new Date().toISOString();
    const statements = [
      db.prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(crypto.randomUUID(), invitation.organization_id, user.id, invitation.organization_role, user.id, user.id, now, now),
      db.prepare("UPDATE invitations SET status = 'accepted', accepted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, user.id, now, invitation.id),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'invitation.accepted', 'invitation', ?, ?, ?)").bind(crypto.randomUUID(), invitation.organization_id, invitation.project_id, user.id, invitation.id, JSON.stringify({ email: identity.email }), now),
    ];
    if (invitation.project_id && invitation.project_role) statements.splice(1, 0, db.prepare(`INSERT INTO project_members (id, organization_id, project_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(crypto.randomUUID(), invitation.organization_id, invitation.project_id, user.id, invitation.project_role, user.id, user.id, now, now));
    await db.batch(statements);
    return Response.json({ accepted: true, organizationId: invitation.organization_id, projectId: invitation.project_id });
  } catch (error) { return errorResponse(error); }
}
