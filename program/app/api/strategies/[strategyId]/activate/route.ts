import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../../../lib/content-ops";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import {commitReferenceWrite,nextWriteTimestamp,readReferenceRevision} from "../../../../../lib/reference-write";

export async function POST(request: Request, context: { params: Promise<{ strategyId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再启用内容策略。", 401);
  try {
    const payload = await request.json() as Record<string,unknown>; const organizationId = typeof payload.organizationId==='string'?payload.organizationId.trim():''; const projectId = typeof payload.projectId==='string'?payload.projectId.trim():''; const { strategyId } = await context.params;
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canManageProjectKnowledge(access)) return apiError("STRATEGY_MANAGER_REQUIRED", "只有公司管理员或已分配到当前企业空间的员工可以启用策略。", 403);
    const revision=readReferenceRevision(payload);if(!revision)return apiError('STRATEGY_VERSION_REQUIRED','缺少已读取的策略版本，请刷新后重新核对目标策略。',400);
    const user = await ensureUser(identity); const db = getD1(); const target = await db.prepare("SELECT id, status, version, updated_at, effective_from FROM content_strategies WHERE id = ? AND organization_id = ? AND project_id = ?").bind(strategyId, organizationId, projectId).first<{ id: string; status: string; version: number;updated_at:string;effective_from:string|null }>();
    if (!target) return apiError("STRATEGY_NOT_FOUND", "内容策略不存在。", 404);
    if(target.version!==revision.version)return apiError('STRATEGY_STATE_CHANGED','目标策略版本已改变，本次未启用。请刷新核对。',409);
    if(target.status==='active')return Response.json({strategy:target,idempotent:true});
    if(target.updated_at!==revision.updatedAt||!['draft','retired'].includes(target.status))return apiError('STRATEGY_STATE_CHANGED','目标策略状态已改变，本次未启用。请刷新核对。',409);
    const active=await db.prepare("SELECT id,updated_at FROM content_strategies WHERE organization_id=? AND project_id=? AND status='active'").bind(organizationId,projectId).first<{id:string;updated_at:string}>();
    const now=new Date().toISOString(),updatedAt=nextWriteTimestamp([target.updated_at,active?.updated_at].filter((value):value is string=>Boolean(value)&&Number.isFinite(Date.parse(value!))).sort((left,right)=>Date.parse(left)-Date.parse(right)).at(-1));
    const saved=await commitReferenceWrite(db,{request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:strategyId,version:updatedAt,action:'strategy.activated',targetType:'content_strategy',metadata:{version:target.version,previousActiveId:active?.id??null},
      guard:`EXISTS(SELECT 1 FROM content_strategies WHERE id=? AND organization_id=? AND project_id=? AND status=? AND version=? AND updated_at=?) AND ${active?"EXISTS(SELECT 1 FROM content_strategies WHERE id=? AND organization_id=? AND project_id=? AND status='active' AND updated_at=?)":"NOT EXISTS(SELECT 1 FROM content_strategies WHERE organization_id=? AND project_id=? AND status='active')"}`,
      bindings:[strategyId,organizationId,projectId,target.status,target.version,target.updated_at,...(active?[active.id,organizationId,projectId,active.updated_at]:[organizationId,projectId])],mutate:(marker,markerId)=>[
        ...(active?[db.prepare(`UPDATE content_strategies SET status = 'retired', effective_to = ?, updated_by = ?, updated_at = ? WHERE id=? AND organization_id=? AND project_id=? AND ${marker}`).bind(now,user.id,updatedAt,active.id,organizationId,projectId,markerId)]:[]),
        db.prepare(`UPDATE content_strategies SET status = 'active', effective_from = ?, effective_to = NULL, updated_by = ?, updated_at = ? WHERE id=? AND organization_id=? AND project_id=? AND ${marker}`).bind(now,user.id,updatedAt,strategyId,organizationId,projectId,markerId),
      ]});
    if(!saved){const current=await db.prepare('SELECT id,status,version,updated_at,effective_from FROM content_strategies WHERE id=? AND organization_id=? AND project_id=?').bind(strategyId,organizationId,projectId).first<{id:string;status:string;version:number;updated_at:string;effective_from:string|null}>();if(current?.status==='active'&&current.version===revision.version)return Response.json({strategy:current,idempotent:true});return apiError('STRATEGY_STATE_CHANGED','目标或当前启用策略已改变，本次未启用。请刷新核对。',409);}
    return Response.json({strategy:{id:strategyId,status:'active',version:target.version,effective_from:now,updated_at:updatedAt},idempotent:false});
  } catch (error) { return errorResponse(error); }
}
