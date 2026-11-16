import { getD1, getMediaBucket } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { douyinCookieObjectKey } from "../../../../../../lib/douyin-cookie-snapshot";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";
import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  const workerId = normalizeWorkerId(request.headers.get("x-worker-id"));
  if (!workerId) return apiError("INVALID_WORKER_ID", "x-worker-id 格式无效。", 400);
  const attemptHeader = request.headers.get("x-worker-attempt");
  const fence = attemptHeader ?? request.headers.get("x-job-version");
  const fenceValue = fence !== null && /^\d+$/.test(fence) ? Number(fence) : NaN;
  if (!Number.isSafeInteger(fenceValue) || fenceValue < (attemptHeader === null ? 0 : 1)) return apiError("INVALID_COOKIE_OWNER", "任务执行轮次无效。", 400);
  const fenceColumn = attemptHeader === null ? "version" : "attempt_count";
  try {
    const { jobId } = await context.params;
    const readOwnedJob = () => getD1().prepare(`SELECT organization_id FROM analysis_jobs WHERE id = ? AND source_type = 'url'
      AND collection_mode = 'cookie' AND lease_owner = ? AND lease_expires_at > ? AND ${fenceColumn} = ?
      AND status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND EXISTS(SELECT 1 FROM videos v WHERE v.id=analysis_jobs.video_id
        AND v.organization_id=analysis_jobs.organization_id AND v.project_id=analysis_jobs.project_id AND v.deleted_at IS NULL)`)
      .bind(jobId, workerId, new Date().toISOString(), fenceValue).first<{ organization_id: string }>();
    const job = await readOwnedJob();
    if (!job) return apiError("COOKIE_ACCESS_NOT_AVAILABLE", "任务不存在或分析租约已经失效。", 409);
    const object = await getMediaBucket().get(douyinCookieObjectKey(job.organization_id));
    if (!object) return apiError("COOKIE_SNAPSHOT_NOT_FOUND", "尚未从前端上传抖音 Cookie。", 404);
    const current = await readOwnedJob();
    if (!current || current.organization_id !== job.organization_id) {
      await object.body.cancel();
      return apiError("COOKIE_ACCESS_NOT_AVAILABLE", "任务不存在或分析租约已经失效。", 409);
    }
    return new Response(object.body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": String(object.size) } });
  } catch (error) { return errorResponse(error); }
}
