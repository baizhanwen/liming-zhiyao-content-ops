import { getD1, getMediaObject } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { privateR2Response } from "../../../../../../lib/r2-response";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";
import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  const workerId = normalizeWorkerId(request.headers.get("x-worker-id")); if (!workerId) return apiError("INVALID_WORKER_ID", "x-worker-id 格式无效。", 400);
  const rawAttempt = request.headers.get("x-worker-attempt");
  const attempt = rawAttempt !== null && /^\d+$/.test(rawAttempt) && Number.isSafeInteger(Number(rawAttempt)) && Number(rawAttempt) > 0 ? Number(rawAttempt) : null;
  const assetId = new URL(request.url).searchParams.get("assetId");
  if (rawAttempt !== null && attempt === null || assetId !== null && (!assetId || assetId.length > 100 || attempt === null)) return apiError("INVALID_SOURCE_OWNER", "原片恢复需要有效的附件与执行轮次。", 400);
  try {
    const { jobId } = await context.params; const now = new Date().toISOString();
    const row = await getD1().prepare(`
      SELECT m.r2_key FROM analysis_jobs j
      INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      INNER JOIN media_assets m ON ${assetId ? "m.id=?" : "m.id=v.media_asset_id"} AND m.organization_id = j.organization_id AND m.project_id = j.project_id AND m.video_id=v.id AND m.status = 'active'
      WHERE j.id = ? AND ${assetId ? "(m.analysis_job_id=j.id OR (j.source_type='upload' AND m.id=j.source_ref AND m.id=v.media_asset_id))" : "j.source_type = 'upload' AND (j.idempotency_key NOT LIKE 'transcript:%' OR m.id=j.source_ref)"}
        AND m.kind IN ('source_video','source_audio') AND v.deleted_at IS NULL AND j.status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND j.lease_owner = ? AND j.lease_expires_at > ?
        ${attempt !== null ? "AND j.attempt_count=?" : ""}
    `).bind(...(assetId ? [assetId] : []), jobId, workerId, now, ...(attempt !== null ? [attempt] : [])).first<{ r2_key: string }>();
    if (!row) return apiError("SOURCE_NOT_AVAILABLE", "上传来源不存在或任务租约已经失效。", 409);
    const located = await getMediaObject(row.r2_key, { range: request.headers }); if (!located) return apiError("SOURCE_NOT_FOUND", "源媒体文件不存在。", 404);
    const owned = await getD1().prepare(`SELECT j.id FROM analysis_jobs j INNER JOIN videos v ON v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id
      WHERE j.id=? AND j.lease_owner=? AND j.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND j.status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND v.deleted_at IS NULL ${attempt !== null ? "AND j.attempt_count=?" : ""}`)
      .bind(jobId, workerId, ...(attempt !== null ? [attempt] : [])).first();
    if (!owned) return apiError("SOURCE_NOT_AVAILABLE", "读取原片期间任务执行权已改变。", 409);
    return privateR2Response(located.object, request, { storageSource: located.source });
  } catch (error) { return errorResponse(error); }
}
