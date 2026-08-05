import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { canManageProjectKnowledge, includesValue, knowledgeCategories, knowledgeSourceTypes } from "../../../lib/content-ops";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问品牌知识。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的品牌知识。", 403);
    const rows = await getD1().prepare(`
      SELECT k.id, k.category, k.title, k.status, k.current_version, k.confirmed_at, k.updated_at,
        v.body, v.source_type, v.source_ref, v.change_summary
      FROM knowledge_items k INNER JOIN knowledge_item_versions v
        ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id
      WHERE k.organization_id = ? AND k.project_id = ? AND k.deleted_at IS NULL
      ORDER BY CASE k.status WHEN 'draft' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, k.updated_at DESC LIMIT 200
    `).bind(organizationId, projectId).all();
    return Response.json({ items: rows.results, canWrite: canWriteProjectAccess(access), canManage: canManageProjectKnowledge(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再添加品牌知识。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : ""; const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim() : ""; const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (title.length < 2 || title.length > 120) return apiError("INVALID_KNOWLEDGE_TITLE", "知识标题需要 2 至 120 个字符。", 400);
    if (body.length < 10 || body.length > 20000) return apiError("INVALID_KNOWLEDGE_BODY", "知识正文需要 10 至 20000 个字符。", 400);
    if (!includesValue(knowledgeCategories, payload.category)) return apiError("INVALID_KNOWLEDGE_CATEGORY", "知识分类无效。", 400);
    if (!includesValue(knowledgeSourceTypes, payload.sourceType)) return apiError("INVALID_KNOWLEDGE_SOURCE", "知识来源无效。", 400);
    const sourceRef = typeof payload.sourceRef === "string" && payload.sourceRef.trim() ? payload.sourceRef.trim().slice(0, 1000) : null;
    if (payload.sourceType !== "manual" && !sourceRef) return apiError("KNOWLEDGE_SOURCE_REF_REQUIRED", "客户资料、反馈或分析沉淀必须填写具体来源。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能添加品牌知识。", 403);
    const user = await ensureUser(identity); const db = getD1(); const itemId = crypto.randomUUID(); const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO knowledge_items (id, organization_id, project_id, category, title, status, current_version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").bind(itemId, organizationId, projectId, payload.category, title, user.id, user.id, now, now),
      db.prepare("INSERT INTO knowledge_item_versions (id, organization_id, project_id, item_id, version, body, source_type, source_ref, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, '首次录入', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, itemId, body, payload.sourceType, sourceRef, user.id, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'knowledge.created', 'knowledge_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, itemId, JSON.stringify({ category: payload.category, sourceType: payload.sourceType }), now),
    ]);
    return Response.json({ item: { id: itemId, category: payload.category, title, body, source_type: payload.sourceType, source_ref: sourceRef, status: "draft", current_version: 1, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
