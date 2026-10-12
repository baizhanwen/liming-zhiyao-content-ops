import { executeAnalysisJobAction, AnalysisJobActionStatusUnknownError } from "../../../../../lib/analysis-job-action";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError } from "../../../../../lib/project-write-access";
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
    const scope = { organizationId: job.organization_id, projectId: job.project_id, userId: user.id };
    const assertAccess = createProjectWriteAssertion(db, scope, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    await assertAccess();
    const state = await executeAnalysisJobAction(db, {
      scope, job, action: "cancelled", now, toStatus: "cancelled", progress: job.progress,
      metadata: { previousStatus: job.status, reason: "user_cancelled" }, guard: "status = ?", guardBindings: [job.status],
      mutate: (marker, markerId) => db.prepare(`UPDATE analysis_jobs SET status = 'cancelled',
        current_stage = CASE WHEN lease_owner IS NOT NULL AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          THEN '任务已取消，等待释放处理资源' ELSE '任务已取消' END,
        last_heartbeat_at = NULL, result_key = NULL, version = version + 1,
        updated_by = ?, updated_at = ? WHERE id = ? AND ${marker}`).bind(user.id, now, jobId, markerId),
    });
    if (!state) {
      await assertAccess();
      return apiError("JOB_STATE_CHANGED", "任务状态已经变化，请刷新后再试。", 409);
    }
    return Response.json({ job: state });
  } catch (error) {
    if (error instanceof ProjectWriteAccessChangedError) return apiError(error.code, "登录状态或项目权限已改变，本次任务操作未执行。请刷新确认权限后再操作。", 403);
    if (error instanceof AnalysisJobActionStatusUnknownError) return apiError(error.code, error.message, 503);
    return errorResponse(error);
  }
}
