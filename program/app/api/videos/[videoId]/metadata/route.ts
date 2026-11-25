import { canWriteProjectAccess, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readBoundedJson, RequestBodyError } from "../../../../../lib/bounded-request-body";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { collectVideoMetadata } from "../../../../../lib/video-metadata-runtime";

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新作品资料。", 401);
  try {
    const body = await readBoundedJson(request, 4096, "请求内容过大。") as { organizationId?: unknown; projectId?: unknown } | null;
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "请选择公司与企业空间。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("ACCESS_DENIED", "无权更新该空间的作品资料。", 403);
    const { videoId } = await context.params;
    const { status, message, httpStatus } = await collectVideoMetadata({ organizationId, projectId, userId: access.userId, videoId });
    if (httpStatus !== 200) return apiError("VIDEO_METADATA_UNAVAILABLE", message, httpStatus);
    return Response.json({ status, message });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiError(error.code, error.message, error.status);
    return errorResponse(error);
  }
}
