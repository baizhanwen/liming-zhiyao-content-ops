import { ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { canCommentOnContent, resolveContentCommentSchema } from "../../../../lib/content-workflow";
import { readRequestIdentity } from "../../../../lib/request-auth";

import { commitContentWorkflowWrite, nextWriteTimestamp } from "../../../../lib/content-workflow-write";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ commentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再处理评论。", 401);
  try {
    const parsed = resolveContentCommentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_COMMENT_UPDATE", "评论处理参数无效。", 400);
    const { organizationId, projectId, resolved, expectedUpdatedAt } = parsed.data; const { commentId } = await context.params; const db = getD1();
    const comment = await db.prepare("SELECT cc.visibility,cc.content_item_id,cc.updated_at FROM content_comments cc JOIN content_items ci ON ci.id=cc.content_item_id AND ci.organization_id=cc.organization_id AND ci.project_id=cc.project_id WHERE cc.id = ? AND cc.organization_id = ? AND cc.project_id = ? AND cc.deleted_at IS NULL AND ci.deleted_at IS NULL AND ci.status!='archived'").bind(commentId, organizationId, projectId).first<{ visibility:"internal"|"client";content_item_id:string;updated_at:string }>();
    if (!comment) return apiError("COMMENT_NOT_FOUND", "评论不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canCommentOnContent(access, comment.visibility)) return apiError("COMMENT_ACCESS_DENIED", "当前角色不能处理这条评论。", 403);
    if(comment.updated_at!==expectedUpdatedAt)return apiError("COMMENT_STATE_CHANGED","评论已被更新，本次未覆盖，请刷新核对。",409);
    const user=await ensureUser(identity),now=nextWriteTimestamp(comment.updated_at),resolvedAt=resolved?new Date().toISOString():null;
    const committed=await commitContentWorkflowWrite(db,{
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:comment.content_item_id,version:now,
      action:resolved?"content.comment.resolved":"content.comment.reopened",targetType:"content_item",metadata:{commentId,resolved},
      guard:"EXISTS(SELECT 1 FROM content_comments cc JOIN content_items ci ON ci.id=cc.content_item_id AND ci.organization_id=cc.organization_id AND ci.project_id=cc.project_id WHERE cc.id=? AND cc.organization_id=? AND cc.project_id=? AND cc.updated_at=? AND cc.deleted_at IS NULL AND ci.deleted_at IS NULL AND ci.status!='archived')",
      bindings:[commentId,organizationId,projectId,comment.updated_at],
      mutate:(exists,marker)=>db.prepare(`UPDATE content_comments SET resolved_by=?,resolved_at=?,updated_at=? WHERE id=? AND organization_id=? AND project_id=? AND deleted_at IS NULL AND updated_at=? AND ${exists}`)
        .bind(resolved?user.id:null,resolvedAt,now,commentId,organizationId,projectId,comment.updated_at,marker),
    });
    if(!committed)return apiError("COMMENT_STATE_CHANGED","评论或内容状态已变化，本次未保存，请刷新核对。",409);
    return Response.json({ comment: { id: commentId, resolved_at: resolvedAt, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
