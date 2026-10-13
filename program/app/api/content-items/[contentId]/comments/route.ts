import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canCommentOnContent, createContentCommentSchema } from "../../../../../lib/content-workflow";
import { readRequestIdentity } from "../../../../../lib/request-auth";

import { commitContentWorkflowWrite, nextWriteTimestamp } from "../../../../../lib/content-workflow-write";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再发表评论。", 401);
  try {
    const parsed = createContentCommentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_COMMENT", parsed.error.issues[0]?.message || "评论内容无效。", 400);
    const { organizationId, projectId, visibility, body, anchor, expectedVersion } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canCommentOnContent(access, visibility)) return apiError("COMMENT_ACCESS_DENIED", "当前角色不能发表这类评论。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT c.current_version,c.status,c.updated_at, v.id AS version_id FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.status != 'archived'").bind(contentId, organizationId, projectId).first<{ current_version:number;status:string;updated_at:string;version_id: string }>();
    if (!item) return apiError("CONTENT_NOT_FOUND", "内容不存在或已归档。", 404);
    if(expectedVersion!==item.current_version)return apiError("CONTENT_VERSION_CONFLICT","稿件已更新，本次评论未保存，请刷新核对后再发表评论。",409);
    const user=await ensureUser(identity),now=nextWriteTimestamp(item.updated_at),commentId=crypto.randomUUID();
    const committed=await commitContentWorkflowWrite(db,{
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:contentId,version:now,
      action:"content.comment.created",targetType:"content_item",metadata:{commentId,visibility,version:item.current_version},
      guard:"EXISTS(SELECT 1 FROM content_items c JOIN content_versions v ON v.content_item_id=c.id AND v.version=c.current_version AND v.organization_id=c.organization_id AND v.project_id=c.project_id WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.current_version=? AND v.id=? AND c.status=? AND c.updated_at=? AND c.deleted_at IS NULL)",
      bindings:[contentId,organizationId,projectId,item.current_version,item.version_id,item.status,item.updated_at],
      mutate:(exists,marker)=>db.prepare(`INSERT INTO content_comments(id,organization_id,project_id,content_item_id,content_version_id,author_user_id,visibility,body,anchor_json,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${exists}`)
        .bind(commentId,organizationId,projectId,contentId,item.version_id,user.id,visibility,body,anchor?JSON.stringify(anchor):null,now,now,marker),
    });
    if(!committed)return apiError("COMMENT_STATE_CHANGED","稿件状态或版本已变化，本次评论未保存，请刷新核对。",409);
    return Response.json({ comment: { id: commentId, content_item_id: contentId, content_version_id: item.version_id, visibility, body, anchor_json: anchor ? JSON.stringify(anchor) : null, resolved_at: null, created_at: now, updated_at: now, author_name: user.display_name, author_email: user.email } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
