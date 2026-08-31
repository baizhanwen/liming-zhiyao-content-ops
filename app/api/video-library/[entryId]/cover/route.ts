import { getD1, getMediaObject } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { privateR2Response } from "../../../../../lib/r2-response";
import { getAccessibleLibrarySource } from "../../../../../lib/video-library";

export async function GET(request: Request, context: { params: Promise<{ entryId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再读取素材封面。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const { entryId } = await context.params; const source = await getAccessibleLibrarySource(identity.authSubject, organizationId, entryId, projectId);
    if (!source) return apiError("ACCESS_DENIED", "无权读取该素材封面。", 403);
    const row = await getD1().prepare("SELECT r2_key FROM media_assets WHERE organization_id = ? AND project_id = ? AND video_id = ? AND kind = 'keyframe' AND status = 'active' ORDER BY is_cover DESC, COALESCE(quality_score, 0) DESC, created_at ASC LIMIT 1").bind(organizationId, source.source_project_id, source.video_id).first<{ r2_key: string }>();
    if (!row) return apiError("COVER_NOT_FOUND", "该素材暂时没有可用封面。", 404);
    const located = await getMediaObject(row.r2_key, { range: request.headers }); if (!located) return apiError("COVER_NOT_FOUND", "素材封面文件不存在。", 404);
    return privateR2Response(located.object, request, { storageSource: located.source });
  } catch (error) { return errorResponse(error); }
}
