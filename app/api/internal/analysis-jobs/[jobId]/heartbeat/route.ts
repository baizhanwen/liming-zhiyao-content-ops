import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseHeartbeatPayload, validateHeartbeatTransition, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = parseHeartbeatPayload(await request.json()); if (!payload) return apiError("INVALID_HEARTBEAT", "心跳参数无效。", 400);
    const { jobId } = await context.params; const db = getD1(); const now = new Date(); const nowIso = now.toISOString();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.progress, j.current_stage, j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const violation = validateHeartbeatTransition(job, payload, nowIso); if (violation) return apiError(violation, "任务租约、版本或状态已发生变化。", 409);
    const leaseExpiresAt = new Date(now.getTime() + payload.leaseSeconds * 1000).toISOString(); const eventType = job.status === payload.status ? "heartbeat" : "stage_changed";
    const results = await db.batch([
      db.prepare("UPDATE analysis_jobs SET status = ?, progress = ?, current_stage = ?, lease_expires_at = ?, last_heartbeat_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND version = ? AND lease_expires_at > ?")
        .bind(payload.status, payload.progress, payload.stage, leaseExpiresAt, nowIso, `service:${payload.workerId}`, nowIso, jobId, payload.workerId, payload.version, nowIso),
      db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, worker_id, created_at) SELECT ?, organization_id, project_id, id, video_id, ?, ?, status, progress, ?, ? FROM analysis_jobs WHERE id = ? AND lease_owner = ? AND version = ?")
        .bind(crypto.randomUUID(), eventType, job.status, payload.workerId, nowIso, jobId, payload.workerId, payload.version + 1),
    ]);
    if (!results[0].meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，请停止当前处理。", 409);
    return Response.json({ job: { id: jobId, status: payload.status, progress: payload.progress, currentStage: payload.stage, leaseExpiresAt, version: payload.version + 1 } });
  } catch (error) { return errorResponse(error); }
}
