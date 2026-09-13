import { canManageProjectKnowledge } from "../../../lib/content-ops";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { createInspirationCardWithDb, serializeInspirationCard } from "../../../lib/project-inspiration-card";
import { readRequestIdentity } from "../../../lib/request-auth";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const list = (value: unknown, max: number, itemMax: number) => Array.isArray(value) ? value.map((item) => text(item, itemMax)).filter(Boolean).slice(0, max) : [];
const evidence = (value: unknown) => Array.isArray(value) ? value.map((item) => {
  const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
  return { sourceType: text(row.sourceType, 60), sourceId: text(row.sourceId, 160), quote: text(row.quote, 4000) || null };
}).filter((item) => item.sourceType && item.sourceId).slice(0, 20) : [];

function parsePayload(payload: Record<string, unknown>) {
  const organizationId = text(payload.organizationId, 100); const projectId = text(payload.projectId, 100);
  const title = text(payload.title, 160); const coreInsight = text(payload.coreInsight, 20_000); const sourceType = text(payload.sourceType, 60) || "manual"; const sourceId = text(payload.sourceId, 160) || null;
  return { organizationId, projectId, title, coreInsight, canonicalKey: text(payload.canonicalKey, 160), applicableScenarios: list(payload.applicableScenarios, 20, 500), excludedScenarios: list(payload.excludedScenarios, 20, 500), evidence: evidence(payload.evidence), sourceType, sourceId, tags: list(payload.tags, 30, 80), confidence: typeof payload.confidence === "number" ? Math.max(0, Math.min(100, Math.round(payload.confidence))) : null };
}

function validate(card: ReturnType<typeof parsePayload>) {
  if (!card.organizationId || !card.projectId || !card.canonicalKey || card.canonicalKey.length < 2 || card.title.length < 2 || card.coreInsight.length < 10) return apiError("INSPIRATION_FIELDS_REQUIRED", "灵感卡片需要唯一键、标题和至少 10 个字符的核心启发。", 400);
  if (card.sourceType !== "manual" && !card.sourceId) return apiError("INSPIRATION_SOURCE_REQUIRED", "非人工灵感卡片必须填写来源 ID。", 400);
  return null;
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问灵感卡片。", 401);
  const url = new URL(request.url); const organizationId = text(url.searchParams.get("organizationId"), 100); const projectId = text(url.searchParams.get("projectId"), 100); const status = text(url.searchParams.get("status"), 30);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目灵感。", 403);
    const bindings: unknown[] = [organizationId, projectId]; const clauses = ["organization_id = ?", "project_id = ?"]; if (["candidate", "confirmed", "rejected", "superseded", "archived"].includes(status)) { clauses.push("status = ?"); bindings.push(status); }
    const rows = await getD1().prepare("SELECT project_inspiration_cards.*, (SELECT json_group_array(json_object('conversationId', s.conversation_id, 'messageId', s.message_id, 'memoryItemId', s.memory_item_id)) FROM project_inspiration_card_sources s WHERE s.card_id = project_inspiration_cards.id) AS source_trace_json FROM project_inspiration_cards WHERE " + clauses.join(" AND ") + " ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'rejected' THEN 2 WHEN 'archived' THEN 3 ELSE 4 END, updated_at DESC LIMIT 300").bind(...bindings).all<Record<string, unknown>>();
    return Response.json({ cards: rows.results.map(serializeInspirationCard), canWrite: canWriteProjectAccess(access), canManage: canManageProjectKnowledge(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存灵感卡片。", 401);
  try {
    const card = parsePayload(await request.json() as Record<string, unknown>); const invalid = validate(card); if (invalid) return invalid;
    const access = await getProjectAccess(identity.authSubject, card.organizationId, card.projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能提出灵感卡片。", 403);
    const user = await ensureUser(identity); const result = await createInspirationCardWithDb(getD1(), { ...card, userId: user.id });
    const now = new Date().toISOString(); await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'inspiration_card.created', 'inspiration_card', ?, ?, ?)").bind(crypto.randomUUID(), card.organizationId, card.projectId, user.id, result.id, JSON.stringify({ version: result.version, sourceType: card.sourceType }), now).run();
    return Response.json({ card: result, confirmationRequired: true }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}