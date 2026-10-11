import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { isLeasedAnalysisStatus } from "../../../../../../lib/analysis-jobs";
import { normalizeWorkerId, requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const workerId = normalizeWorkerId(request.headers.get("x-worker-id"));
    const attempt = Number(request.headers.get("x-worker-attempt"));
    if (!workerId) return apiError("INVALID_WORKER_ID", "workerId 格式无效。", 400);
    const { jobId } = await context.params;
    const job = await getD1().prepare("SELECT status, lease_owner, lease_expires_at, version, progress, attempt_count FROM analysis_jobs WHERE id = ?")
      .bind(jobId).first<{ status: string; lease_owner: string | null; lease_expires_at: string | null; version: number; progress: number; attempt_count: number }>();
    if (!job) return apiError("JOB_NOT_FOUND", "任务已不存在，停止处理。", 404);
    if (!isLeasedAnalysisStatus(job.status) || job.lease_owner !== workerId || attempt !== job.attempt_count || !job.lease_expires_at || job.lease_expires_at <= new Date().toISOString()) {
      return apiError("JOB_EXECUTION_REVOKED", "任务已取消、结束或失去执行权，停止处理。", 409);
    }
    return Response.json({ status: job.status, version: job.version, progress: job.progress }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
