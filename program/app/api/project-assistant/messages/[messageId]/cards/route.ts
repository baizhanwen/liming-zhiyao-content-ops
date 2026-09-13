import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { saveProjectAssistantRecommendationsWithDb } from "../../../../../../lib/project-assistant-cards";
import type { ProjectAssistantDatabase } from "../../../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function POST(request: Request, context: { params: Promise<{ messageId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存灵感卡片。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    const { messageId } = await context.params;
    const recommendationIndexes = Array.isArray(payload.recommendationIndexes)
      ? payload.recommendationIndexes.map(Number).filter(Number.isInteger)
      : [];
    if (!organizationId || !projectId || !messageId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或回复范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能保存灵感卡片。", 403);
    const user = await ensureUser(identity);
    const cards = await saveProjectAssistantRecommendationsWithDb(
      getD1() as unknown as ProjectAssistantDatabase,
      {
        organizationId,
        projectId,
        messageId,
        userId: user.id,
        recommendationIndexes,
        saveReply: payload.saveReply === true,
      },
    );
    const now = new Date().toISOString();
    for (const card of cards.filter((item) => !item.existing)) {
      await getD1().prepare(
        "INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'inspiration_card.saved_from_assistant', 'inspiration_card', ?, ?, ?)",
      ).bind(crypto.randomUUID(), organizationId, projectId, user.id, card.id, JSON.stringify({ messageId, recommendationIndex: card.index }), now).run();
    }
    return Response.json({ cards }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && (error.message.includes("不存在") || error.message.includes("没有可保存"))) {
      return apiError("ASSISTANT_RECOMMENDATION_NOT_FOUND", error.message, 404);
    }
    return errorResponse(error);
  }
}
