import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseCheckpointPayload, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = parseCheckpointPayload(await request.json());
    if (!payload) return apiError("INVALID_ANALYSIS_CHECKPOINT", "分析检查点格式无效或体积超限。", 400);
    const { jobId } = await context.params; const db = getD1(); const now = new Date().toISOString();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.progress, j.current_stage,
        j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= now) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
    if (job.version !== payload.version) return apiError("JOB_VERSION_CONFLICT", "任务版本已发生变化。", 409);
    if (!["extracting", "analyzing"].includes(job.status)) return apiError("CHECKPOINT_STAGE_INVALID", "当前任务阶段不能保存分析检查点。", 409);
    const result = await db.prepare(`
      UPDATE analysis_jobs SET checkpoint_stage = ?, checkpoint_json = ?, checkpoint_updated_at = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND version = ? AND lease_expires_at > ?
    `).bind(payload.stage, payload.checkpointJson, now, `service:${payload.workerId}`, now, jobId, payload.workerId, payload.version, now).run();
    if (!result.meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，检查点未保存。", 409);
    return Response.json({ checkpoint: { stage: payload.stage, updatedAt: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
