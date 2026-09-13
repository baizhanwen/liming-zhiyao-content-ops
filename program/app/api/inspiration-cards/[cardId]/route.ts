import { canManageProjectKnowledge } from "../../../../lib/content-ops";
import { ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { createInspirationCardWithDb, serializeInspirationCard } from "../../../../lib/project-inspiration-card";
import { enqueueProjectMemoryEventWithDb, type ProjectAssistantDatabase } from "../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../lib/request-auth";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const list = (value: unknown, max: number, itemMax: number) => Array.isArray(value) ? value.map((item) => text(item, itemMax)).filter(Boolean).slice(0, max) : [];
const evidence = (value: unknown) => Array.isArray(value) ? value.map((item) => {
  const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
  return { sourceType: text(row.sourceType, 60), sourceId: text(row.sourceId, 160), quote: text(row.quote, 4000) || null };
}).filter((item) => item.sourceType && item.sourceId).slice(0, 20) : [];

async function scope(request: Request, cardId: string) {
  const identity = await readRequestIdentity(request); if (!identity) return { error: apiError("AUTH_REQUIRED", "请先登录后再管理灵感卡片。", 401) } as const;
  const url = new URL(request.url); const organizationId = text(url.searchParams.get("organizationId"), 100); const projectId = text(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId || !cardId) return { error: apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或灵感范围。", 400) } as const;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return { error: apiError("ACCESS_DENIED", "无权访问该项目灵感。", 403) } as const;
  return { identity, organizationId, projectId, cardId, access } as const;
}

function parsePayload(payload: Record<string, unknown>) {
  const title = text(payload.title, 160); const coreInsight = text(payload.coreInsight, 20_000); const sourceType = text(payload.sourceType, 60) || "manual"; const sourceId = text(payload.sourceId, 160) || null;
  const card = { title, coreInsight, applicableScenarios: list(payload.applicableScenarios, 20, 500), excludedScenarios: list(payload.excludedScenarios, 20, 500), evidence: evidence(payload.evidence), sourceType, sourceId, tags: list(payload.tags, 30, 80), confidence: typeof payload.confidence === "number" ? Math.max(0, Math.min(100, Math.round(payload.confidence))) : null };
  if (title.length < 2 || coreInsight.length < 10) return { error: apiError("INSPIRATION_FIELDS_REQUIRED", "灵感卡片需要标题和至少 10 个字符的核心启发。", 400) } as const;
  if (sourceType !== "manual" && !sourceId) return { error: apiError("INSPIRATION_SOURCE_REQUIRED", "非人工灵感卡片必须填写来源 ID。", 400) } as const;
  return { card } as const;
}

export async function GET(request: Request, context: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await context.params; const current = await scope(request, cardId); if ("error" in current) return current.error;
  try {
    const rows = await getD1().prepare("SELECT project_inspiration_cards.*, (SELECT json_group_array(json_object('conversationId', s.conversation_id, 'messageId', s.message_id, 'memoryItemId', s.memory_item_id)) FROM project_inspiration_card_sources s WHERE s.card_id = project_inspiration_cards.id) AS source_trace_json FROM project_inspiration_cards WHERE organization_id = ? AND project_id = ? AND canonical_key = (SELECT canonical_key FROM project_inspiration_cards WHERE id = ? AND organization_id = ? AND project_id = ?) ORDER BY version DESC").bind(current.organizationId, current.projectId, current.cardId, current.organizationId, current.projectId).all<Record<string, unknown>>();
    if (!rows.results.length) return apiError("INSPIRATION_NOT_FOUND", "灵感卡片不存在。", 404);
    return Response.json({ cardId: current.cardId, history: rows.results.map(serializeInspirationCard), canManage: canManageProjectKnowledge(current.access) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await context.params; const current = await scope(request, cardId); if ("error" in current) return current.error;
  try {
    if (!canManageProjectKnowledge(current.access)) return apiError("INSPIRATION_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以编辑灵感卡片。", 403);
    const existing = await getD1().prepare("SELECT canonical_key, status FROM project_inspiration_cards WHERE id = ? AND organization_id = ? AND project_id = ?").bind(current.cardId, current.organizationId, current.projectId).first<{ canonical_key: string; status: string }>();
    if (!existing) return apiError("INSPIRATION_NOT_FOUND", "灵感卡片不存在。", 404);
    if (!["candidate", "confirmed"].includes(existing.status)) return apiError("INSPIRATION_NOT_ACTIONABLE", "该灵感卡片当前状态不可编辑。", 409);
    const parsed = parsePayload(await request.json() as Record<string, unknown>); if ("error" in parsed) return parsed.error;
    const user = await ensureUser(current.identity); const result = await createInspirationCardWithDb(getD1(), { ...parsed.card, organizationId: current.organizationId, projectId: current.projectId, userId: user.id, canonicalKey: existing.canonical_key });
    const now = new Date().toISOString(); await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'inspiration_card.version_created', 'inspiration_card', ?, ?, ?)").bind(crypto.randomUUID(), current.organizationId, current.projectId, user.id, result.id, JSON.stringify({ previousId: current.cardId, version: result.version, sourceType: parsed.card.sourceType }), now).run();
    try {
      await enqueueProjectMemoryEventWithDb(getD1() as unknown as ProjectAssistantDatabase, {
        organizationId: current.organizationId,
        projectId: current.projectId,
        userId: user.id,
        eventType: "inspiration_edited",
        sourceType: "inspiration_card",
        sourceId: result.id,
        payload: { previousId: current.cardId, cardId: result.id, title: parsed.card.title, coreInsight: parsed.card.coreInsight, version: result.version },
      });
    } catch (eventError) {
      console.error("project_memory_feedback_event_failed", { cardId: result.id, message: eventError instanceof Error ? eventError.message : "unknown" });
    }
    return Response.json({ card: result }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await context.params; const current = await scope(request, cardId); if ("error" in current) return current.error;
  try {
    if (!canManageProjectKnowledge(current.access)) return apiError("INSPIRATION_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以归档灵感卡片。", 403);
    const user = await ensureUser(current.identity); const now = new Date().toISOString(); const result = await getD1().prepare("UPDATE project_inspiration_cards SET status = 'archived', updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('candidate', 'confirmed', 'rejected')").bind(now, current.cardId, current.organizationId, current.projectId).run();
    if (!result.meta.changes) return apiError("INSPIRATION_NOT_ARCHIVABLE", "灵感卡片不存在或已经归档。", 409);
    await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'inspiration_card.archived', 'inspiration_card', ?, ?, ?)").bind(crypto.randomUUID(), current.organizationId, current.projectId, user.id, current.cardId, JSON.stringify({ status: "archived" }), now).run();
    return Response.json({ id: current.cardId, status: "archived" });
  } catch (error) { return errorResponse(error); }
}
