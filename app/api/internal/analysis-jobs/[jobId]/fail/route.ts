import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { canWorkerFail, parseFailurePayload, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = parseFailurePayload(await request.json()); if (!payload) return apiError("INVALID_FAILURE_RESULT", "失败结果格式无效。", 400);
    const { jobId } = await context.params; const db = getD1(); const nowIso = new Date().toISOString();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.progress, j.current_stage, j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    if (job.status === "failed" && job.result_key === payload.resultKey) return Response.json({ job: { id: jobId, status: "failed", version: job.version }, idempotent: true });
    if (!canWorkerFail(job.status)) return apiError("INVALID_STATUS_TRANSITION", "当前任务状态不能标记为失败。", 409);
    if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= nowIso) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
    if (job.version !== payload.version) return apiError("JOB_VERSION_CONFLICT", "任务版本已发生变化。", 409);
    const actor = `service:${payload.workerId}`; const finalVersion = payload.version + 1;
    const results = await db.batch([
      db.prepare("UPDATE analysis_jobs SET status = 'failed', progress = ?, current_stage = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, result_key = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ? AND lease_expires_at > ?")
        .bind(payload.progress, payload.stage, payload.errorCode, payload.errorMessage, payload.resultKey, actor, nowIso, jobId, payload.workerId, payload.version, nowIso),
      db.prepare("UPDATE videos SET status = 'failed', error_message = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.id = ? AND j.video_id = videos.id AND j.status = 'failed' AND j.result_key = ? AND j.version = ?)")
        .bind(payload.errorMessage, actor, nowIso, job.video_id, job.organization_id, job.project_id, jobId, payload.resultKey, finalVersion),
      db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, worker_id, details_json, created_at) SELECT ?, organization_id, project_id, id, video_id, 'failed', ?, 'failed', progress, ?, ?, ? FROM analysis_jobs WHERE id = ? AND result_key = ? AND version = ?")
        .bind(crypto.randomUUID(), job.status, payload.workerId, JSON.stringify({ errorCode: payload.errorCode }), nowIso, jobId, payload.resultKey, finalVersion),
    ]);
    if (!results[0].meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，失败结果未写入。", 409);
    return Response.json({ job: { id: jobId, status: "failed", progress: payload.progress, version: finalVersion }, idempotent: false });
  } catch (error) { return errorResponse(error); }
}
