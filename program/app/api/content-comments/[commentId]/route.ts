import { ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { canCommentOnContent, resolveContentCommentSchema } from "../../../../lib/content-workflow";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ commentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再处理评论。", 401);
  try {
    const parsed = resolveContentCommentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_COMMENT_UPDATE", "评论处理参数无效。", 400);
    const { organizationId, projectId, resolved } = parsed.data; const { commentId } = await context.params; const db = getD1();
    const comment = await db.prepare("SELECT visibility FROM content_comments WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(commentId, organizationId, projectId).first<{ visibility: "internal" | "client" }>();
    if (!comment) return apiError("COMMENT_NOT_FOUND", "评论不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canCommentOnContent(access, comment.visibility)) return apiError("COMMENT_ACCESS_DENIED", "当前角色不能处理这条评论。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const result = await db.prepare("UPDATE content_comments SET resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(resolved ? user.id : null, resolved ? now : null, now, commentId, organizationId, projectId).run();
    if (!result.meta.changes) return apiError("COMMENT_STATE_CHANGED", "评论状态已变化，请刷新后重试。", 409);
    return Response.json({ comment: { id: commentId, resolved_at: resolved ? now : null, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
