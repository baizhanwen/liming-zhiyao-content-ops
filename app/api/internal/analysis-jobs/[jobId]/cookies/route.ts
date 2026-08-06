import { getD1, getMediaBucket } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { douyinCookieObjectKey } from "../../../../../../lib/douyin-cookie-snapshot";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  const workerId = normalizeWorkerId(request.headers.get("x-worker-id"));
  if (!workerId) return apiError("INVALID_WORKER_ID", "x-worker-id 格式无效。", 400);
  try {
    const { jobId } = await context.params; const now = new Date().toISOString();
    const job = await getD1().prepare("SELECT organization_id FROM analysis_jobs WHERE id = ? AND source_type = 'url' AND lease_owner = ? AND lease_expires_at > ?")
      .bind(jobId, workerId, now).first<{ organization_id: string }>();
    if (!job) return apiError("COOKIE_ACCESS_NOT_AVAILABLE", "任务不存在或分析租约已经失效。", 409);
    const object = await getMediaBucket().get(douyinCookieObjectKey(job.organization_id));
    if (!object) return apiError("COOKIE_SNAPSHOT_NOT_FOUND", "尚未从前端上传抖音 Cookie。", 404);
    return new Response(object.body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": String(object.size) } });
  } catch (error) { return errorResponse(error); }
}
