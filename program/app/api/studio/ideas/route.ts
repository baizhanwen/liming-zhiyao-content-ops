import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../db/runtime";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { listStudioIdeas } from "../../../../lib/studio-ideas";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看灵感库。", 401);
  const params = new URL(request.url).searchParams;
  const organizationId = params.get("organizationId")?.trim() || "";
  const projectId = params.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "请先选择企业空间。", 400);
  const id = params.get("ideaId")?.trim(), kind = params.get("ideaKind");
  if ((id || kind) && (!id || (kind !== "card" && kind !== "topic"))) return apiError("INVALID_IDEA", "请选择有效的灵感。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权查看该空间的灵感库。", 403);
    const detailed = params.get("view") === "library";
    const offset = Number(params.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return apiError("INVALID_IDEA_PAGE", "灵感列表页码无效。", 400);
    const result = await listStudioIdeas(getD1(), { organizationId, projectId }, {
      detailed, history: detailed && params.get("history") === "1", query: params.get("q")?.trim().slice(0,300),
      id, kind: kind === "topic" || kind === "card" ? kind : undefined, focusId: detailed ? params.get("focusId") || undefined : undefined, offset,
    });
    return Response.json({...result, canWrite:canWriteProjectAccess(access), canDelete:access.organizationRole === "admin"});
  } catch (error) { return errorResponse(error); }
}
