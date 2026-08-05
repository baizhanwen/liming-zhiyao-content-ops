import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readRequestIdentity } from "../../../../../lib/request-auth";

type JobRow = { id: string; organization_id: string; project_id: string; status: string; retry_count: number };

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再重试任务。", 401);
  try {
    const { jobId } = await context.params; const db = getD1();
    const job = await db.prepare("SELECT id, organization_id, project_id, status, retry_count FROM analysis_jobs WHERE id = ?").bind(jobId).first<JobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, job.organization_id, job.project_id);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能重试分析任务。", 403);
    if (job.status !== "failed" && job.status !== "cancelled") return apiError("JOB_NOT_RETRYABLE", "只有失败或已取消的任务可以重试。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const result = await db.prepare("UPDATE analysis_jobs SET status = 'pending', progress = 0, current_stage = '等待重新进入分析队列', error_code = NULL, error_message = NULL, retry_count = retry_count + 1, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL, result_key = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled')").bind(user.id, now, jobId).run();
    if (!result.meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已经变化，请刷新后重试。", 409);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analysis_job.retried', 'analysis_job', ?, ?, ?)").bind(crypto.randomUUID(), job.organization_id, job.project_id, user.id, jobId, JSON.stringify({ previousStatus: job.status, retryCount: job.retry_count + 1 }), now).run();
    return Response.json({ job: { id: jobId, status: "pending", progress: 0, current_stage: "等待重新进入分析队列", retry_count: job.retry_count + 1, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
