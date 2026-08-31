import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../../../lib/content-ops";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export async function POST(request: Request, context: { params: Promise<{ strategyId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再启用内容策略。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string }; const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? ""; const { strategyId } = await context.params;
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canManageProjectKnowledge(access)) return apiError("STRATEGY_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以启用策略。", 403);
    const user = await ensureUser(identity); const db = getD1(); const target = await db.prepare("SELECT id, status, version FROM content_strategies WHERE id = ? AND organization_id = ? AND project_id = ?").bind(strategyId, organizationId, projectId).first<{ id: string; status: string; version: number }>();
    if (!target) return apiError("STRATEGY_NOT_FOUND", "内容策略不存在。", 404); if (target.status === "active") return Response.json({ strategy: target, idempotent: true });
    const now = new Date().toISOString(); const results = await db.batch([
      db.prepare("UPDATE content_strategies SET status = 'retired', effective_to = ?, updated_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM content_strategies target WHERE target.id = ? AND target.organization_id = ? AND target.project_id = ? AND target.status IN ('draft', 'retired'))").bind(now, user.id, now, organizationId, projectId, strategyId, organizationId, projectId),
      db.prepare("UPDATE content_strategies SET status = 'active', effective_from = ?, effective_to = NULL, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('draft', 'retired')").bind(now, user.id, now, strategyId, organizationId, projectId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, organization_id, project_id, ?, 'strategy.activated', 'content_strategy', id, ?, ? FROM content_strategies WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active' AND effective_from = ?").bind(crypto.randomUUID(), user.id, JSON.stringify({ version: target.version }), now, strategyId, organizationId, projectId, now),
    ]);
    if (!results[1].meta.changes) return apiError("STRATEGY_STATE_CHANGED", "策略状态已经变化，请刷新后重试。", 409);
    return Response.json({ strategy: { id: strategyId, status: "active", effective_from: now }, idempotent: false });
  } catch (error) { return errorResponse(error); }
}
