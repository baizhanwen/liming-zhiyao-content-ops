import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../../../lib/content-ops";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再确认品牌知识。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string }; const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? ""; const { itemId } = await context.params;
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canManageProjectKnowledge(access)) return apiError("KNOWLEDGE_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以确认品牌知识。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare("UPDATE knowledge_items SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'draft' AND deleted_at IS NULL").bind(user.id, now, user.id, now, itemId, organizationId, projectId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, created_at) SELECT ?, organization_id, project_id, ?, 'knowledge.confirmed', 'knowledge_item', id, ? FROM knowledge_items WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'confirmed' AND confirmed_by = ? AND confirmed_at = ?").bind(crypto.randomUUID(), user.id, now, itemId, organizationId, projectId, user.id, now),
    ]);
    if (!results[0].meta.changes) return apiError("KNOWLEDGE_NOT_CONFIRMABLE", "知识不存在、已确认或状态已变化。", 409);
    return Response.json({ item: { id: itemId, status: "confirmed", confirmed_at: now } });
  } catch (error) { return errorResponse(error); }
}
