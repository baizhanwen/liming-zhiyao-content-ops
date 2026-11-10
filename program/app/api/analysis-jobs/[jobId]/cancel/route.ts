import { isActiveAnalysisStatus } from "../../../../../lib/analysis-jobs";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";

type JobRow = { id: string; organization_id: string; project_id: string; video_id: string; status: string; progress: number; version: number };

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再取消任务。", 401);
  try {
    const { jobId } = await context.params; const db = getD1();
    const job = await db.prepare("SELECT id, organization_id, project_id, video_id, status, progress, version FROM analysis_jobs WHERE id = ?").bind(jobId).first<JobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, job.organization_id, job.project_id);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能取消分析任务。", 403);
    if (!isActiveAnalysisStatus(job.status)) return apiError("JOB_NOT_CANCELLABLE", "当前任务已经结束，不能取消。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const result = await db.prepare(`
      UPDATE analysis_jobs SET status = 'cancelled', current_stage = '任务已取消', lease_owner = NULL,
        lease_expires_at = NULL, completed_at = ?, last_progress_at = ?, result_key = NULL, version = version + 1,
        updated_by = ?, updated_at = ? WHERE id = ? AND status = ? AND version = ?
    `).bind(now, now, user.id, now, jobId, job.status, job.version).run();
    if (!result.meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已经变化，请刷新后再试。", 409);
    await db.batch([
      db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, details_json, created_at) VALUES (?, ?, ?, ?, ?, 'stage_changed', ?, 'cancelled', ?, ?, ?)")
        .bind(crypto.randomUUID(), job.organization_id, job.project_id, jobId, job.video_id, job.status, job.progress, JSON.stringify({ reason: "user_cancelled" }), now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analysis_job.cancelled', 'analysis_job', ?, ?, ?)")
        .bind(crypto.randomUUID(), job.organization_id, job.project_id, user.id, jobId, JSON.stringify({ previousStatus: job.status }), now),
    ]);
    return Response.json({ job: { id: jobId, status: "cancelled", progress: job.progress, current_stage: "任务已取消", updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
