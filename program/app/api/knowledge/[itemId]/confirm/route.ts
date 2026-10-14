import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../../../lib/content-ops";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import {commitReferenceWrite,nextWriteTimestamp,readReferenceRevision} from "../../../../../lib/reference-write";

export async function POST(request: Request, context: { params: Promise<{ itemId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再确认品牌知识。", 401);
  try {
    const payload = await request.json() as Record<string,unknown>; const organizationId = typeof payload.organizationId==='string'?payload.organizationId.trim():''; const projectId = typeof payload.projectId==='string'?payload.projectId.trim():''; const { itemId } = await context.params;
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canManageProjectKnowledge(access)) return apiError("KNOWLEDGE_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以确认品牌知识。", 403);
    const revision=readReferenceRevision(payload);if(!revision)return apiError('KNOWLEDGE_VERSION_REQUIRED','缺少已读取的资料版本，请刷新并重新核对正文后确认。',400);
    const user=await ensureUser(identity),db=getD1(),now=new Date().toISOString(),updatedAt=nextWriteTimestamp(revision.updatedAt);
    const saved=await commitReferenceWrite(db,{request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:itemId,version:updatedAt,action:'knowledge.confirmed',targetType:'knowledge_item',metadata:{version:revision.version},guard:"EXISTS(SELECT 1 FROM knowledge_items WHERE id=? AND organization_id=? AND project_id=? AND current_version=? AND updated_at=? AND status = 'draft' AND deleted_at IS NULL)",bindings:[itemId,organizationId,projectId,revision.version,revision.updatedAt],mutate:(marker,markerId)=>db.prepare(`UPDATE knowledge_items SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND ${marker}`).bind(user.id,now,user.id,updatedAt,itemId,organizationId,projectId,markerId)});
    if(!saved)return apiError('KNOWLEDGE_NOT_CONFIRMABLE','资料版本或状态已改变，本次未确认。请刷新并重新核对正文。',409);
    return Response.json({item:{id:itemId,status:'confirmed',confirmed_at:now,updated_at:updatedAt,current_version:revision.version}});
  } catch (error) { return errorResponse(error); }
}
