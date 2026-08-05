import { getD1, getMediaBucket, getProjectAccess } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../../lib/request-auth";
import { privateR2Response } from "../../../../../../lib/r2-response";

export async function GET(request: Request, context: { params: Promise<{ videoId: string; assetId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再读取分析产物。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权读取该项目的分析产物。", 403);
    const { videoId, assetId } = await context.params;
    const row = await getD1().prepare(`
      SELECT a.r2_key FROM media_assets a
      INNER JOIN videos v ON v.id = a.video_id AND v.organization_id = a.organization_id AND v.project_id = a.project_id
      WHERE a.id = ? AND a.video_id = ? AND a.organization_id = ? AND a.project_id = ? AND a.status = 'active' AND v.deleted_at IS NULL
    `).bind(assetId, videoId, organizationId, projectId).first<{ r2_key: string }>();
    if (!row) return apiError("ARTIFACT_NOT_FOUND", "分析产物不存在或不属于当前项目。", 404);
    const object = await getMediaBucket().get(row.r2_key, { range: request.headers });
    if (!object) return apiError("ARTIFACT_NOT_FOUND", "分析产物文件不存在。", 404);
    return privateR2Response(object, request);
  } catch (error) { return errorResponse(error); }
}
