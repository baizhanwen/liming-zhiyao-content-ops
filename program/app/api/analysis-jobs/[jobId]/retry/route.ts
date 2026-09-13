import { ACTIVE_ANALYSIS_STATUSES_SQL } from "../../../../../lib/analysis-jobs";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { resetSegmentForRetry, type SegmentRetryTarget } from "../../../../../lib/analysis-segment-retry";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { isPlainRecord } from "../../../../../lib/service-auth";

type JobRow = { id: string; organization_id: string; project_id: string; status: string; version: number; retry_count: number; lease_expires_at: string | null; checkpoint_stage: string | null; checkpoint_json: string | null; resume_count: number };
type ScriptVersion = "light_rewrite" | "restructured";

const scriptVersionLabels: Record<ScriptVersion, string> = {
  light_rewrite: "微调同构版",
  restructured: "内容等价重构版",
};

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再重试任务。", 401);
  try {
    const { jobId } = await context.params;
    const payload = await request.json().catch(() => ({})) as { segmentKey?: unknown; scriptVersion?: unknown };
    const requestedSegmentKey = typeof payload.segmentKey === "string" ? payload.segmentKey.trim() : "";
    const requestedScriptVersion = typeof payload.scriptVersion === "string" ? payload.scriptVersion.trim() : "";
    if (requestedSegmentKey && requestedScriptVersion) return apiError("RETRY_TARGET_CONFLICT", "不能同时重试长视频分段和口播版本。", 400);
    if (requestedScriptVersion && !(requestedScriptVersion in scriptVersionLabels)) return apiError("SCRIPT_VERSION_INVALID", "口播版本参数无效。", 400);

    const db = getD1();
    const job = await db.prepare("SELECT id, organization_id, project_id, status, version, retry_count, lease_expires_at, checkpoint_stage, checkpoint_json, resume_count FROM analysis_jobs WHERE id = ?").bind(jobId).first<JobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const access = await getProjectAccess(identity.authSubject, job.organization_id, job.project_id);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能重试分析任务。", 403);

    const now = new Date().toISOString();
    const staleLease = !["pending", "completed", "partial", "failed", "cancelled"].includes(job.status) && Boolean(job.lease_expires_at && job.lease_expires_at <= now);
    if (job.status !== "partial" && job.status !== "failed" && job.status !== "cancelled" && !staleLease) {
      return apiError("JOB_NOT_RETRYABLE", "只有部分完成、失败、已取消或租约过期的任务可以恢复。", 409);
    }
    const user = await ensureUser(identity);
    const canResume = job.checkpoint_stage === "evidence_ready" || job.checkpoint_stage === "segment_progress";
    let retryCheckpointJson: string | null = null;
    let retryTarget: SegmentRetryTarget | null = null;
    if (requestedSegmentKey) {
      if (job.checkpoint_stage !== "segment_progress") return apiError("SEGMENT_RETRY_UNAVAILABLE", "当前任务没有可单独重试的分段检查点。", 409);
      const reset = resetSegmentForRetry(job.checkpoint_json, requestedSegmentKey);
      if (!reset) return apiError("SEGMENT_NOT_RETRYABLE", "该分段不存在、已完成或检查点已失效。", 409);
      retryCheckpointJson = reset.checkpointJson;
      retryTarget = reset.target;
    }
    if (requestedScriptVersion) {
      if (!["partial", "failed"].includes(job.status) || !canResume || !job.checkpoint_json) {
        return apiError("SCRIPT_RETRY_UNAVAILABLE", "当前报告没有可用于单独重试口播版本的证据检查点，请使用整份重新分析。", 409);
      }
      let checkpoint: unknown;
      try {
        checkpoint = JSON.parse(job.checkpoint_json) as unknown;
      } catch {
        return apiError("SCRIPT_RETRY_CHECKPOINT_INVALID", "口播重试检查点已损坏，请使用整份重新分析。", 409);
      }
      if (!isPlainRecord(checkpoint)) return apiError("SCRIPT_RETRY_CHECKPOINT_INVALID", "口播重试检查点格式无效，请使用整份重新分析。", 409);
      const previousSet = isPlainRecord(checkpoint.previous_spoken_script_set)
        ? checkpoint.previous_spoken_script_set
        : null;
      const previousVersion = previousSet && isPlainRecord(previousSet[requestedScriptVersion])
        ? previousSet[requestedScriptVersion]
        : null;
      if (!previousVersion || previousVersion.status !== "failed") {
        return apiError("SCRIPT_VERSION_NOT_FAILED", "只有明确失败的口播版本可以单独重试。", 409);
      }
      retryCheckpointJson = JSON.stringify({
        ...checkpoint,
        retry_script_version: requestedScriptVersion,
      });
      if (retryCheckpointJson.length > 1_000_000) {
        return apiError("SCRIPT_RETRY_CHECKPOINT_TOO_LARGE", "口播重试检查点体积超限，请使用整份重新分析。", 409);
      }
    }

    const scriptVersion = requestedScriptVersion as ScriptVersion | "";
    const stage = scriptVersion
      ? `等待单独重试${scriptVersionLabels[scriptVersion]}`
      : canResume
        ? "等待从证据检查点继续结构分析"
        : "等待重新进入分析队列";
    const result = await db.prepare(`UPDATE analysis_jobs SET status = 'pending', progress = CASE WHEN checkpoint_stage IN ('evidence_ready', 'segment_progress') THEN 82 ELSE 0 END, checkpoint_json = COALESCE(?, checkpoint_json), checkpoint_updated_at = COALESCE(?, checkpoint_updated_at), current_stage = ?, error_code = NULL, error_message = NULL, completed_at = NULL, retry_count = retry_count + 1, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL, result_key = NULL, version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND version = ? AND (status IN ('partial', 'failed', 'cancelled') OR (status NOT IN ('pending', 'completed', 'partial', 'failed', 'cancelled') AND lease_expires_at <= ?))
        AND NOT EXISTS (
          SELECT 1 FROM analysis_jobs other WHERE other.organization_id = analysis_jobs.organization_id
            AND other.project_id = analysis_jobs.project_id AND other.video_id = analysis_jobs.video_id AND other.id != analysis_jobs.id
            AND other.status IN (${ACTIVE_ANALYSIS_STATUSES_SQL})
        )`)
      .bind(retryCheckpointJson, retryCheckpointJson ? now : null, stage, user.id, now, jobId, job.version, now).run();
    if (!result.meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已经变化，或该视频已有其他分析任务，请刷新后重试。", 409);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analysis_job.retried', 'analysis_job', ?, ?, ?)")
      .bind(crypto.randomUUID(), job.organization_id, job.project_id, user.id, jobId, JSON.stringify({ previousStatus: job.status, retryCount: job.retry_count + 1, staleLease, checkpointStage: job.checkpoint_stage, canResume, segmentKey: requestedSegmentKey || null, segmentRetryTarget: retryTarget, scriptVersion: scriptVersion || null }), now).run();
    return Response.json({
      job: {
        id: jobId,
        status: "pending",
        progress: canResume ? 82 : 0,
        current_stage: stage,
        retry_count: job.retry_count + 1,
        checkpoint_stage: job.checkpoint_stage,
        resume_count: job.resume_count,
        segmentKey: requestedSegmentKey || null,
        scriptVersion: scriptVersion || null,
        updated_at: now,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
