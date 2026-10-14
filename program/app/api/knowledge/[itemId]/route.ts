import { canManageProjectKnowledge, includesValue, knowledgeCategories, knowledgeSourceTypes } from "../../../../lib/content-ops";
import { ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import {commitReferenceWrite,nextWriteTimestamp,readReferenceRevision} from "../../../../lib/reference-write";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function scope(request: Request, itemId: string) {
  const identity = await readRequestIdentity(request);
  if (!identity) return { error: apiError("AUTH_REQUIRED", "请先登录后再管理品牌知识。", 401) } as const;
  const url = new URL(request.url); const organizationId = text(url.searchParams.get("organizationId"), 100); const projectId = text(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId || !itemId) return { error: apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或知识范围。", 400) } as const;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
  if (!access) return { error: apiError("ACCESS_DENIED", "无权访问该项目的品牌知识。", 403) } as const;
  return { identity, organizationId, projectId, access, itemId } as const;
}

export async function GET(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params; const current = await scope(request, itemId); if ("error" in current) return current.error;
  try {
    const db = getD1(); const rows = await db.prepare("SELECT k.id, k.category, k.title, k.status, k.current_version, k.confirmed_at, k.deleted_at, k.updated_at, v.id AS version_id, v.version, v.body, v.source_type, v.source_ref, v.change_summary, v.created_by, v.created_at FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.id = ? AND k.organization_id = ? AND k.project_id = ? ORDER BY v.version DESC").bind(current.itemId, current.organizationId, current.projectId).all();
    if (!rows.results.length) return apiError("KNOWLEDGE_NOT_FOUND", "品牌知识不存在。", 404);
    return Response.json({ itemId: current.itemId, history: rows.results, canManage: canManageProjectKnowledge(current.access) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params; const current = await scope(request, itemId); if ("error" in current) return current.error;
  try {
    if (!canManageProjectKnowledge(current.access)) return apiError("KNOWLEDGE_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以编辑品牌知识。", 403);
    const payload = await request.json() as Record<string, unknown>; const title = typeof payload.title==='string'?payload.title.trim():''; const body = typeof payload.body==='string'?payload.body.trim():''; const sourceRef = text(payload.sourceRef, 1_000) || null; const changeSummary = text(payload.changeSummary, 500) || "编辑产生新版本";
    const revision=readReferenceRevision(payload);if(!revision)return apiError('KNOWLEDGE_VERSION_REQUIRED','缺少已读取的资料版本，请刷新列表后重新编辑；先复制当前修改。',400);
    if (title.length < 2 || title.length>120) return apiError("INVALID_KNOWLEDGE_TITLE", "知识标题需要 2 至 120 个字符。", 400);
    if (body.length < 10 || body.length>20000) return apiError("INVALID_KNOWLEDGE_BODY", "知识正文需要 10 至 20000 个字符；超长内容不会截断保存。", 400);
    if (!includesValue(knowledgeCategories, payload.category) || !includesValue(knowledgeSourceTypes, payload.sourceType)) return apiError("INVALID_KNOWLEDGE_FIELDS", "知识分类或来源无效。", 400);
    if (payload.sourceType !== "manual" && !sourceRef) return apiError("KNOWLEDGE_SOURCE_REF_REQUIRED", "非人工知识必须填写具体来源。", 400);
    const db = getD1(); const item = await db.prepare("SELECT current_version, status, updated_at FROM knowledge_items WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL LIMIT 1").bind(current.itemId, current.organizationId, current.projectId).first<{ current_version: number; status: string;updated_at:string }>();
    if (!item) return apiError("KNOWLEDGE_NOT_FOUND", "品牌知识不存在或已归档。", 404);
    if(item.status==='archived'||revision.version!==item.current_version||revision.updatedAt!==item.updated_at)return apiError('KNOWLEDGE_STATE_CHANGED','知识版本或状态已改变，本次未保存。请先复制修改，再刷新核对。',409);
    const user = await ensureUser(current.identity); const now = nextWriteTimestamp(item.updated_at); const nextVersion = Number(item.current_version) + 1;
    const saved=await commitReferenceWrite(db,{request,authSubject:current.identity.authSubject,scope:{organizationId:current.organizationId,projectId:current.projectId,userId:user.id},targetId:current.itemId,version:now,action:'knowledge.version_created',targetType:'knowledge_item',metadata:{previousVersion:item.current_version,version:nextVersion,sourceType:payload.sourceType},
      guard:"EXISTS(SELECT 1 FROM knowledge_items WHERE id=? AND organization_id=? AND project_id=? AND current_version=? AND status=? AND updated_at=? AND deleted_at IS NULL)",bindings:[current.itemId,current.organizationId,current.projectId,item.current_version,item.status,item.updated_at],mutate:(marker,markerId)=>[
        db.prepare(`UPDATE knowledge_items SET category = ?, title = ?, status = 'draft', current_version = ?, confirmed_by = NULL, confirmed_at = NULL, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND ${marker}`).bind(payload.category,title,nextVersion,user.id,now,current.itemId,current.organizationId,current.projectId,markerId),
        db.prepare(`INSERT INTO knowledge_item_versions (id, organization_id, project_id, item_id, version, body, source_type, source_ref, change_summary, created_by, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${marker}`).bind(crypto.randomUUID(),current.organizationId,current.projectId,current.itemId,nextVersion,body,payload.sourceType,sourceRef,changeSummary,user.id,now,markerId),
      ]});
    if (!saved) return apiError("KNOWLEDGE_STATE_CHANGED", "知识状态已经变化，本次未保存。请先复制修改，再刷新核对。", 409);
    return Response.json({ item: { id: current.itemId, category: payload.category, title, body, source_type: payload.sourceType, source_ref: sourceRef, status: "draft", current_version: nextVersion, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await context.params; const current = await scope(request, itemId); if ("error" in current) return current.error;
  try {
    if (!canManageProjectKnowledge(current.access)) return apiError("KNOWLEDGE_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以归档品牌知识。", 403);
    const payload=await request.json() as Record<string,unknown>,revision=readReferenceRevision(payload);
    if(!revision)return apiError('KNOWLEDGE_VERSION_REQUIRED','缺少已读取的资料版本，请刷新后重新确认归档。',400);
    const user=await ensureUser(current.identity),db=getD1(),now=nextWriteTimestamp(revision.updatedAt);
    const saved=await commitReferenceWrite(db,{request,authSubject:current.identity.authSubject,scope:{organizationId:current.organizationId,projectId:current.projectId,userId:user.id},targetId:current.itemId,version:now,action:'knowledge.archived',targetType:'knowledge_item',metadata:{status:'archived',version:revision.version},guard:"EXISTS(SELECT 1 FROM knowledge_items WHERE id=? AND organization_id=? AND project_id=? AND current_version=? AND updated_at=? AND status!='archived' AND deleted_at IS NULL)",bindings:[current.itemId,current.organizationId,current.projectId,revision.version,revision.updatedAt],mutate:(marker,markerId)=>db.prepare(`UPDATE knowledge_items SET status = 'archived', deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND ${marker}`).bind(now,user.id,now,current.itemId,current.organizationId,current.projectId,markerId)});
    if(!saved)return apiError('KNOWLEDGE_NOT_ARCHIVABLE','资料版本或状态已改变，本次没有归档。请刷新核对后重新确认。',409);
    return Response.json({ id: current.itemId, status: "archived" });
  } catch (error) { return errorResponse(error); }
}
