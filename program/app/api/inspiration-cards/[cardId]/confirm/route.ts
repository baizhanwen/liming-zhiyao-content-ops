import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { transitionInspirationCard } from "../../../../../lib/project-inspiration-card-state";
import { enqueueProjectMemoryEventWithDb, type ProjectAssistantDatabase } from "../../../../../lib/project-memory-events";

export async function POST(request: Request, context: { params: Promise<{ cardId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再确认灵感卡片。", 401);
  try {
    const payload = await request.json() as { organizationId?: unknown; projectId?: unknown; action?: unknown }; const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : ""; const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : ""; const action = payload.action === "reject" ? "reject" : "confirm"; const { cardId } = await context.params;
    if (!organizationId || !projectId || !cardId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或灵感范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能确认灵感卡片。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString(); const result = await transitionInspirationCard({ db: getD1(), cardId, organizationId, projectId, userId: user.id, action, now });
    if (!result.ok) {
      if (result.reason === "not_found") return apiError("INSPIRATION_NOT_FOUND", "灵感卡片不存在。", 404);
      if (result.reason === "not_actionable") return apiError("INSPIRATION_NOT_ACTIONABLE", "该灵感卡片当前状态不可执行此操作。", 409);
      return apiError("INSPIRATION_STATE_CHANGED", "灵感卡片状态已变化，请刷新后重试。", 409);
    }
    await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, 'inspiration_card', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, "inspiration_card." + action, cardId, JSON.stringify({ status: result.status }), now).run();
    try {
      const card = await getD1().prepare("SELECT title, core_insight, tags_json, confidence, source_type, source_id FROM project_inspiration_cards WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1").bind(cardId, organizationId, projectId).first<Record<string, unknown>>();
      await enqueueProjectMemoryEventWithDb(getD1() as unknown as ProjectAssistantDatabase, {
        organizationId,
        projectId,
        userId: user.id,
        eventType: action === "confirm" ? "inspiration_accepted" : "inspiration_rejected",
        sourceType: "inspiration_card",
        sourceId: cardId,
        payload: { action, status: result.status, card },
      });
    } catch (eventError) {
      console.error("project_memory_feedback_event_failed", { cardId, action, message: eventError instanceof Error ? eventError.message : "unknown" });
    }
    return Response.json({ id: cardId, status: result.status });
  } catch (error) { return errorResponse(error); }
}