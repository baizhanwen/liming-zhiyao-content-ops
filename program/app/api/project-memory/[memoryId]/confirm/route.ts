import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { transitionProjectMemory } from "../../../../../lib/project-memory";
export async function POST(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再处理项目记忆。", 401);
  try { const payload = await request.json() as { organizationId?: unknown; projectId?: unknown; action?: unknown }; const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : ""; const projectId = typeof payload.projectId === "string" ? payload.projectId.trim() : ""; const action = payload.action === "reject" ? "reject" : "confirm"; const { memoryId } = await context.params; if (!organizationId || !projectId || !memoryId) return apiError("MEMORY_SCOPE_REQUIRED", "缺少账号记忆范围。", 400); const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能采纳或不采纳项目记忆。", 403); const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString(); const result = await transitionProjectMemory({ db, memoryId, organizationId, projectId, userId: user.id, action, now });
    if (!result.ok) {
      if (result.reason === "not_found") return apiError("MEMORY_NOT_FOUND", "账号记忆不存在。", 404);
      if (result.reason === "not_actionable") return apiError("MEMORY_NOT_ACTIONABLE", "该账号记忆当前状态不可执行此操作。", 409);
      return apiError("MEMORY_STATE_CHANGED", "账号记忆状态已变化，请刷新后重试。", 409);
    }
    return Response.json({ id: memoryId, status: result.status }); } catch (error) { return errorResponse(error); }
}
