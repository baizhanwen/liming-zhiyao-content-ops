import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { canManageProjectKnowledge, cleanStringList, parseJsonValue } from "../../../lib/content-ops";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问内容策略。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的内容策略。", 403);
    const rows = await getD1().prepare("SELECT id, version, name, status, positioning, persona, target_audience, pain_points_json, pillars_json, topic_mix_json, style_notes, cadence, conversion_path, objectives_json, effective_from, effective_to, created_at, updated_at FROM content_strategies WHERE organization_id = ? AND project_id = ? ORDER BY version DESC LIMIT 50").bind(organizationId, projectId).all();
    return Response.json({ strategies: rows.results.map((row) => ({ ...row, pain_points: parseJsonValue(String(row.pain_points_json)), pillars: parseJsonValue(String(row.pillars_json)), topic_mix: parseJsonValue(String(row.topic_mix_json)), objectives: parseJsonValue(String(row.objectives_json)), pain_points_json: undefined, pillars_json: undefined, topic_mix_json: undefined, objectives_json: undefined })), canWrite: canWriteProjectAccess(access), canManage: canManageProjectKnowledge(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建内容策略。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : ""; const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
    const name = typeof payload.name === "string" ? payload.name.trim() : ""; const positioning = typeof payload.positioning === "string" ? payload.positioning.trim() : ""; const targetAudience = typeof payload.targetAudience === "string" ? payload.targetAudience.trim() : "";
    const painPoints = cleanStringList(payload.painPoints); const pillars = cleanStringList(payload.pillars); const objectives = cleanStringList(payload.objectives);
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (name.length < 2 || name.length > 100 || positioning.length < 5 || positioning.length > 2000 || targetAudience.length < 2 || targetAudience.length > 1000) return apiError("INVALID_STRATEGY_CORE", "策略名称、账号定位或目标人群不完整。", 400);
    if (!painPoints || !pillars || !objectives) return apiError("INVALID_STRATEGY_LISTS", "至少填写一个用户痛点、内容支柱和阶段目标。", 400);
    const topicMix = Array.isArray(payload.topicMix) ? payload.topicMix.flatMap((item) => {
      if (!item || typeof item !== "object") return []; const row = item as Record<string, unknown>; const pillar = typeof row.pillar === "string" ? row.pillar.trim().slice(0, 100) : ""; const ratio = typeof row.ratio === "number" && Number.isFinite(row.ratio) ? Math.max(0, Math.min(100, Math.trunc(row.ratio))) : 0; return pillar ? [{ pillar, ratio }] : [];
    }).slice(0, 20) : [];
    if (!topicMix.length || topicMix.reduce((total, item) => total + item.ratio, 0) !== 100) return apiError("INVALID_TOPIC_MIX", "选题比例至少包含一项，且合计必须为 100%。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建内容策略。", 403);
    const user = await ensureUser(identity); const db = getD1(); const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM content_strategies WHERE organization_id = ? AND project_id = ?").bind(organizationId, projectId).first<{ version: number }>();
    const version = (latest?.version ?? 0) + 1; const strategyId = crypto.randomUUID(); const now = new Date().toISOString();
    const optional = (key: string, max: number) => typeof payload[key] === "string" && payload[key].trim() ? payload[key].trim().slice(0, max) : null;
    await db.batch([
      db.prepare("INSERT INTO content_strategies (id, organization_id, project_id, version, name, status, positioning, persona, target_audience, pain_points_json, pillars_json, topic_mix_json, style_notes, cadence, conversion_path, objectives_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(strategyId, organizationId, projectId, version, name, positioning, optional("persona", 1000), targetAudience, JSON.stringify(painPoints), JSON.stringify(pillars), JSON.stringify(topicMix), optional("styleNotes", 2000), optional("cadence", 500), optional("conversionPath", 2000), JSON.stringify(objectives), user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'strategy.created', 'content_strategy', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, strategyId, JSON.stringify({ version, name }), now),
    ]);
    return Response.json({ strategy: { id: strategyId, version, name, status: "draft", positioning, target_audience: targetAudience, pain_points: painPoints, pillars, topic_mix: topicMix, objectives, created_at: now, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
