import { readScopedAnalysisMedia } from "../../../../../lib/analysis-media";
import { getD1, getMediaObject, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { privateR2Response } from "../../../../../lib/r2-response";

export async function GET(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再读取媒体。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const analysisId = url.searchParams.get("analysisId")?.trim() || null;
  if (analysisId && analysisId.length > 200) return apiError("INVALID_ANALYSIS_VERSION", "分析版本无效。", 400);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权读取该项目的媒体。", 403);
    const { videoId } = await context.params;
    const selected = await readScopedAnalysisMedia(getD1(), { organizationId, projectId, videoId }, analysisId);
    if (!selected.analysisFound) return apiError("ANALYSIS_NOT_FOUND", "指定分析版本不属于此视频。", 404);
    const row = selected.media;
    if (!row) return apiError("MEDIA_NOT_FOUND", "媒体不存在或不属于当前项目。", 404);
    const located = await getMediaObject(row.r2_key, { range: request.headers }); if (!located) return apiError("MEDIA_NOT_FOUND", "媒体文件不存在。", 404);
    return privateR2Response(located.object, request, { storageSource: located.source });
  } catch (error) { return errorResponse(error); }
}
