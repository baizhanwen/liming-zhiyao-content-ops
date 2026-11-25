import { getD1, getMediaObject } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { privateR2Response } from "../../../../../lib/r2-response";
import { getAccessibleLibrarySource } from "../../../../../lib/video-library";
import { videoCoverOrder } from "../../../../../lib/video-cover";

export async function GET(request: Request, context: { params: Promise<{ entryId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再读取素材封面。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  const wanted = url.searchParams.get("source");
  if (wanted !== null && wanted !== "platform" && wanted !== "keyframe") return apiError("INVALID_COVER_SOURCE", "封面来源无效。", 400);
  const kind = wanted === "platform" ? "platform_cover" : wanted;
  try {
    const { entryId } = await context.params; const source = await getAccessibleLibrarySource(identity.authSubject, organizationId, entryId, projectId);
    if (!source) return apiError("ACCESS_DENIED", "无权读取该素材封面。", 403);
    const rows = await getD1().prepare(`
      SELECT frame.kind, frame.r2_key FROM media_assets frame
      WHERE frame.organization_id = ? AND frame.project_id = ? AND frame.video_id = ?
        AND frame.kind IN ('platform_cover', 'keyframe') AND frame.status = 'active'
        AND (? IS NULL OR frame.kind = ?)
      ORDER BY ${videoCoverOrder}
    `).bind(organizationId, source.source_project_id, source.video_id, kind, kind).all<{ kind: string; r2_key: string }>();
    for (const row of rows.results) {
      const located = await getMediaObject(row.r2_key, { range: request.headers });
      if (located) {
        const response = privateR2Response(located.object, request, { storageSource: located.source });
        response.headers.set("x-video-cover-source", row.kind === "platform_cover" ? "platform" : "keyframe");
        response.headers.set("x-content-type-options", "nosniff");
        return response;
      }
    }
    return apiError("COVER_NOT_FOUND", "该素材暂时没有可用封面。", 404);
  } catch (error) { return errorResponse(error); }
}
