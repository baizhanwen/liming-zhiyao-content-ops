import { ensureUser, getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function PATCH(request: Request, context: { params: Promise<{ memoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新个人备忘。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = text(payload.organizationId, 100); const action = payload.action === "reopen" ? "reopen" : "complete"; const { memoId } = await context.params;
    if (!organizationId || !memoId) return apiError("MEMO_SCOPE_REQUIRED", "缺少个人备忘范围。", 400);
    if (!await getOrganizationAccess(identity.authSubject, organizationId)) return apiError("ACCESS_DENIED", "无权更新该公司的个人备忘。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString(); const status = action === "reopen" ? "active" : "completed";
    const result = await getD1().prepare("UPDATE personal_memos SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND owner_user_id = ? AND status IN ('active','completed')").bind(status, status === "completed" ? now : null, now, memoId, organizationId, user.id).run();
    if (!result.meta.changes) return apiError("MEMO_NOT_FOUND", "没有找到这条个人备忘。", 404);
    return Response.json({ id: memoId, status });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ memoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再删除个人备忘。", 401);
  const organizationId = text(new URL(request.url).searchParams.get("organizationId"), 100); const { memoId } = await context.params;
  if (!organizationId || !memoId) return apiError("MEMO_SCOPE_REQUIRED", "缺少个人备忘范围。", 400);
  try {
    if (!await getOrganizationAccess(identity.authSubject, organizationId)) return apiError("ACCESS_DENIED", "无权删除该公司的个人备忘。", 403);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const result = await getD1().prepare("UPDATE personal_memos SET status = 'archived', updated_at = ? WHERE id = ? AND organization_id = ? AND owner_user_id = ? AND status != 'archived'").bind(now, memoId, organizationId, user.id).run();
    if (!result.meta.changes) return apiError("MEMO_NOT_FOUND", "没有找到这条个人备忘。", 404);
    return Response.json({ id: memoId, status: "archived" });
  } catch (error) { return errorResponse(error); }
}
