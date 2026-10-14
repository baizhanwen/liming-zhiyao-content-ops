import { canWriteProjectAccess, ensureUser, getD1, getOrganizationAccess, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { canManageProjectKnowledge, cleanStringList, parseJsonValue } from "../../../lib/content-ops";
import { readRequestIdentity } from "../../../lib/request-auth";
import {commitReferenceWrite,referenceWriteUnknown} from "../../../lib/reference-write";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问内容策略。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? ""; const scope = url.searchParams.get("scope")?.trim() ?? "project";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    if (scope === "organization") {
      const organizationAccess = await getOrganizationAccess(identity.authSubject, organizationId);
      if (!organizationAccess || organizationAccess.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以查看全部企业空间的内容策略。", 403);
      const rows = await getD1().prepare(`
        SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
               s.id AS strategy_id, s.version AS strategy_version, s.name AS strategy_name, s.status AS strategy_status,
               s.positioning, s.target_audience, s.pain_points_json, s.pillars_json, s.objectives_json,
               s.cadence, s.conversion_path, s.effective_from, s.updated_at
        FROM projects p
        LEFT JOIN content_strategies s ON s.organization_id = p.organization_id AND s.project_id = p.id
        WHERE p.organization_id = ? AND p.deleted_at IS NULL
        ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
                 p.created_at DESC, s.version DESC
        LIMIT 1000
      `).bind(organizationId).all<Record<string, unknown>>();
      const spaces = new Map<string, { id: string; name: string; status: string; strategies: Record<string, unknown>[] }>();
      for (const row of rows.results) {
        const id = String(row.project_id); let space = spaces.get(id);
        if (!space) { space = { id, name: String(row.project_name), status: String(row.project_status), strategies: [] }; spaces.set(id, space); }
        if (!row.strategy_id) continue;
        space.strategies.push({
          id: String(row.strategy_id), version: Number(row.strategy_version), name: String(row.strategy_name), status: String(row.strategy_status),
          positioning: String(row.positioning || ""), target_audience: String(row.target_audience || ""),
          pain_points: parseJsonValue(typeof row.pain_points_json === "string" ? row.pain_points_json : null) ?? [],
          pillars: parseJsonValue(typeof row.pillars_json === "string" ? row.pillars_json : null) ?? [],
          objectives: parseJsonValue(typeof row.objectives_json === "string" ? row.objectives_json : null) ?? [],
          cadence: row.cadence ?? null, conversion_path: row.conversion_path ?? null,
          effective_from: row.effective_from ?? null, updated_at: row.updated_at,
        });
      }
      return Response.json({ scope: "organization", organizationRole: organizationAccess.organizationRole, spaces: Array.from(spaces.values()) });
    }
    if (!projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少项目范围。", 400);
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
    const user = await ensureUser(identity); const db = getD1(); const strategyId = crypto.randomUUID(); const now = new Date().toISOString();
    const optional = (key: string, max: number) => typeof payload[key] === "string" && payload[key].trim() ? payload[key].trim().slice(0, max) : null;
    const saved=await commitReferenceWrite(db,{request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:strategyId,version:now,action:'strategy.created',targetType:'content_strategy',metadata:{name},guard:'1',bindings:[],mutate:(marker,markerId)=>[
      // Allocate from the database inside this transaction, not a stale preflight.
      db.prepare(`INSERT INTO content_strategies (id, organization_id, project_id, version, name, status, positioning, persona, target_audience, pain_points_json, pillars_json, topic_mix_json, style_notes, cadence, conversion_path, objectives_json, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM content_strategies WHERE organization_id=? AND project_id=?), ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${marker}`).bind(strategyId,organizationId,projectId,organizationId,projectId,name,positioning,optional('persona',1000),targetAudience,JSON.stringify(painPoints),JSON.stringify(pillars),JSON.stringify(topicMix),optional('styleNotes',2000),optional('cadence',500),optional('conversionPath',2000),JSON.stringify(objectives),user.id,user.id,now,now,markerId),
      db.prepare(`UPDATE audit_logs SET metadata_json=json_set(metadata_json,'$.version',(SELECT version FROM content_strategies WHERE id=? AND organization_id=? AND project_id=?)) WHERE id=? AND ${marker}`).bind(strategyId,organizationId,projectId,markerId,markerId),
    ]});
    if(!saved)return apiError('STRATEGY_STATE_CHANGED','空间状态已改变，本次策略未保存。请刷新核对，先复制填写内容。',409);
    let stored:{version:number}|null;try{stored=await db.prepare('SELECT version FROM content_strategies WHERE id=? AND organization_id=? AND project_id=?').bind(strategyId,organizationId,projectId).first<{version:number}>();}catch{throw referenceWriteUnknown();}
    if(!stored)throw referenceWriteUnknown();const version=stored.version;
    return Response.json({ strategy: { id: strategyId, version, name, status: "draft", positioning, target_audience: targetAudience, pain_points: painPoints, pillars, topic_mix: topicMix, objectives, created_at: now, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
