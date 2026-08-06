import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";

type JobRow = { id: string; organization_id: string; project_id: string; status: string; retry_count: number; lease_expires_at: string | null; checkpoint_stage: string | null; resume_count: number };

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再重试任务。", 401);
  try {
    const { jobId } = await context.params; const db = getD1();
    const job = await db.prepare("SELECT id, organization_id, project_id, status, retry_count, lease_expires_at, checkpoint_stage, resume_count FROM analysis_jobs WHERE id = ?").bind(jobId).first<JobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, job.organization_id, job.project_id);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能重试分析任务。", 403);
    const now = new Date().toISOString(); const staleLease = !["pending", "completed", "failed", "cancelled"].includes(job.status) && Boolean(job.lease_expires_at && job.lease_expires_at <= now);
    if (job.status !== "failed" && job.status !== "cancelled" && !staleLease) return apiError("JOB_NOT_RETRYABLE", "只有失败、已取消或租约过期的任务可以恢复。", 409);
    const user = await ensureUser(identity);
    const canResume = job.checkpoint_stage === "evidence_ready";
    const stage = canResume ? "等待从证据检查点继续结构分析" : "等待重新进入分析队列";
    const result = await db.prepare("UPDATE analysis_jobs SET status = 'pending', progress = CASE WHEN checkpoint_stage = 'evidence_ready' THEN 82 ELSE 0 END, current_stage = ?, error_code = NULL, error_message = NULL, retry_count = retry_count + 1, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL, result_key = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND (status IN ('failed', 'cancelled') OR (status NOT IN ('pending', 'completed', 'failed', 'cancelled') AND lease_expires_at <= ?))").bind(stage, user.id, now, jobId, now).run();
    if (!result.meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已经变化，请刷新后重试。", 409);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analysis_job.retried', 'analysis_job', ?, ?, ?)").bind(crypto.randomUUID(), job.organization_id, job.project_id, user.id, jobId, JSON.stringify({ previousStatus: job.status, retryCount: job.retry_count + 1, staleLease, checkpointStage: job.checkpoint_stage, canResume }), now).run();
    return Response.json({ job: { id: jobId, status: "pending", progress: canResume ? 82 : 0, current_stage: stage, retry_count: job.retry_count + 1, checkpoint_stage: job.checkpoint_stage, resume_count: job.resume_count, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
