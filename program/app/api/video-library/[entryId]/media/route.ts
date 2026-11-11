import { readScopedAnalysisMedia } from "../../../../../lib/analysis-media";
import { getD1, getMediaObject } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { privateR2Response } from "../../../../../lib/r2-response";
import { getAccessibleLibrarySource } from "../../../../../lib/video-library";

export async function GET(request: Request, context: { params: Promise<{ entryId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再读取素材媒体。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const analysisId = url.searchParams.get("analysisId")?.trim() || null;
  if (analysisId && analysisId.length > 200) return apiError("INVALID_ANALYSIS_VERSION", "分析版本无效。", 400);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const { entryId } = await context.params; const source = await getAccessibleLibrarySource(identity.authSubject, organizationId, entryId, projectId);
    if (!source) return apiError("ACCESS_DENIED", "无权读取该素材媒体。", 403);
    const selected = await readScopedAnalysisMedia(getD1(), { organizationId, projectId: source.source_project_id, videoId: source.video_id }, analysisId);
    if (!selected.analysisFound) return apiError("ANALYSIS_NOT_FOUND", "指定分析版本不属于此素材。", 404);
    const row = selected.media;
    if (!row) return apiError("MEDIA_NOT_FOUND", "该素材没有本地媒体文件。", 404);
    const located = await getMediaObject(row.r2_key, { range: request.headers }); if (!located) return apiError("MEDIA_NOT_FOUND", "素材媒体文件不存在。", 404);
    return privateR2Response(located.object, request, { storageSource: located.source });
  } catch (error) { return errorResponse(error); }
}
