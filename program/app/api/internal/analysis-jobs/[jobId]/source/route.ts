import { getD1, getMediaObject } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { privateR2Response } from "../../../../../../lib/r2-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  const workerId = normalizeWorkerId(request.headers.get("x-worker-id")); if (!workerId) return apiError("INVALID_WORKER_ID", "x-worker-id 格式无效。", 400);
  try {
    const { jobId } = await context.params; const now = new Date().toISOString();
    const row = await getD1().prepare(`
      SELECT m.r2_key FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      INNER JOIN media_assets m ON m.id = v.media_asset_id AND m.organization_id = j.organization_id AND m.project_id = j.project_id AND m.status = 'active'
      WHERE j.id = ? AND j.source_type = 'upload' AND (j.idempotency_key NOT LIKE 'transcript:%' OR (m.id=j.source_ref AND m.kind IN ('source_video','source_audio') AND v.deleted_at IS NULL)) AND j.lease_owner = ? AND j.lease_expires_at > ?
    `).bind(jobId, workerId, now).first<{ r2_key: string }>();
    if (!row) return apiError("SOURCE_NOT_AVAILABLE", "上传来源不存在或任务租约已经失效。", 409);
    const located = await getMediaObject(row.r2_key, { range: request.headers }); if (!located) return apiError("SOURCE_NOT_FOUND", "源媒体文件不存在。", 404);
    return privateR2Response(located.object, request, { storageSource: located.source });
  } catch (error) { return errorResponse(error); }
}
