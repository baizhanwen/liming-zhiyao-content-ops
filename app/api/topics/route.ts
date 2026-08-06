import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

const MAX_KNOWLEDGE_SOURCES = 20;

function knowledgeSourceIds(payload: Record<string, unknown>) {
  const legacy = typeof payload.sourceKnowledgeItemId === "string" ? payload.sourceKnowledgeItemId.trim() : "";
  const raw = Array.isArray(payload.sourceKnowledgeItemIds) ? payload.sourceKnowledgeItemIds : legacy ? [legacy] : [];
  return Array.from(new Set(raw.filter((value): value is string => typeof value === "string").map((value) => value.trim().slice(0, 100)).filter(Boolean)));
}

function analysisQuote(reportJson: string) {
  try {
    const report = JSON.parse(reportJson) as Record<string, unknown>;
    const list = (key: string) => Array.isArray(report[key]) ? (report[key] as unknown[]).filter((item): item is string => typeof item === "string") : [];
    const parts = [
      typeof report.summary === "string" ? `核心结论：${report.summary}` : "",
      ...list("spoken_script").map((item) => `口播段落：${item}`),
      ...list("hook_analysis").map((item) => `钩子：${item}`),
      ...list("viral_points").map((item) => `爆点：${item}`),
      ...list("recommendations").map((item) => `复用建议：${item}`),
    ].filter(Boolean);
    return parts.length ? parts.join("\n").slice(0, 4_000) : null;
  } catch { return null; }
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问选题中心。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的选题。", 403);
    const db = getD1(); const [topics, citations] = await Promise.all([
      db.prepare("SELECT id, title, angle, source_type, source_ref, pillar, audience, objective, hook, rationale, priority, status, created_at, updated_at FROM topic_ideas WHERE organization_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY CASE status WHEN 'selected' THEN 0 WHEN 'idea' THEN 1 WHEN 'drafting' THEN 2 ELSE 3 END, priority DESC, created_at DESC LIMIT 200").bind(organizationId, projectId).all(),
      db.prepare("SELECT id, topic_id, citation_type, citation_id, quote, created_at FROM topic_citations WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 500").bind(organizationId, projectId).all(),
    ]);
    return Response.json({ topics: topics.results, citations: citations.results, canWrite: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建选题。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : ""; const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : ""; const angle = typeof payload.angle === "string" && payload.angle.trim() ? payload.angle.trim().slice(0, 2000) : null;
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (title.length < 2 || title.length > 160) return apiError("INVALID_TOPIC_TITLE", "选题标题需要 2 至 160 个字符。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建选题。", 403);
    const user = await ensureUser(identity); const db = getD1(); const sourceVideoId = typeof payload.sourceVideoId === "string" ? payload.sourceVideoId.trim() : ""; const sourceKnowledgeItemIds = knowledgeSourceIds(payload);
    if (sourceKnowledgeItemIds.length > MAX_KNOWLEDGE_SOURCES) return apiError("TOO_MANY_KNOWLEDGE_SOURCES", `一次最多引用 ${MAX_KNOWLEDGE_SOURCES} 条品牌知识。`, 400);
    let sourceType = "manual"; let sourceRef: string | null = null; let citations: { type: string; id: string; quote: string | null }[] = [];
    if (sourceVideoId) {
      const analysis = await db.prepare(`SELECT a.id, a.report_json FROM video_analyses a INNER JOIN videos v ON v.id = a.video_id AND v.organization_id = a.organization_id AND v.project_id = a.project_id WHERE a.organization_id = ? AND a.project_id = ? AND a.video_id = ? AND v.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 1`).bind(organizationId, projectId, sourceVideoId).first<{ id: string; report_json: string }>();
      if (!analysis) return apiError("ANALYSIS_SOURCE_NOT_FOUND", "未找到可引用的视频分析结果。", 409);
      sourceType = "video_analysis"; sourceRef = sourceVideoId; citations = [{ type: "video_analysis", id: analysis.id, quote: analysisQuote(analysis.report_json) }];
    } else if (sourceKnowledgeItemIds.length) {
      const placeholders = sourceKnowledgeItemIds.map(() => "?").join(", ");
      const knowledge = await db.prepare(`SELECT k.id, v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.id IN (${placeholders}) AND k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL`).bind(...sourceKnowledgeItemIds, organizationId, projectId).all<{ id: string; body: string }>();
      if (knowledge.results.length !== sourceKnowledgeItemIds.length) return apiError("CONFIRMED_KNOWLEDGE_REQUIRED", "只能引用当前项目中已确认的品牌知识。", 409);
      const byId = new Map(knowledge.results.map((item) => [item.id, item]));
      sourceType = "knowledge"; sourceRef = sourceKnowledgeItemIds[0]; citations = sourceKnowledgeItemIds.map((id) => ({ type: "knowledge", id, quote: byId.get(id)!.body.slice(0, 500) }));
    }
    const text = (key: string, max = 1000) => typeof payload[key] === "string" && payload[key].trim() ? payload[key].trim().slice(0, max) : null;
    const priority = typeof payload.priority === "number" && Number.isFinite(payload.priority) ? Math.max(0, Math.min(100, Math.trunc(payload.priority))) : 50; const topicId = crypto.randomUUID(); const now = new Date().toISOString();
    const statements = [
      db.prepare("INSERT INTO topic_ideas (id, organization_id, project_id, title, angle, source_type, source_ref, pillar, audience, objective, hook, rationale, priority, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idea', ?, ?, ?, ?)").bind(topicId, organizationId, projectId, title, angle, sourceType, sourceRef, text("pillar", 200), text("audience"), text("objective"), text("hook", 500), text("rationale", 2000), priority, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'topic.created', 'topic_idea', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, topicId, JSON.stringify({ sourceType, sourceRef, sourceKnowledgeItemIds: sourceType === "knowledge" ? sourceKnowledgeItemIds : [] }), now),
    ];
    const citationRecords = citations.map((citation) => ({ id: crypto.randomUUID(), topic_id: topicId, citation_type: citation.type, citation_id: citation.id, quote: citation.quote }));
    for (const citation of citationRecords) statements.push(db.prepare("INSERT INTO topic_citations (id, organization_id, project_id, topic_id, citation_type, citation_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(citation.id, organizationId, projectId, topicId, citation.citation_type, citation.citation_id, citation.quote, user.id, now));
    await db.batch(statements);
    return Response.json({ topic: { id: topicId, title, angle, source_type: sourceType, source_ref: sourceRef, pillar: text("pillar", 200), audience: text("audience"), objective: text("objective"), hook: text("hook", 500), rationale: text("rationale", 2000), priority, status: "idea", created_at: now, updated_at: now }, citation: citationRecords[0] ?? null, citations: citationRecords }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
