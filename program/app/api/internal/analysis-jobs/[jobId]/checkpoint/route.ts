import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseCheckpointPayload, readTranscriptCheckpoint, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { LEASED_ANALYSIS_STATUSES_SQL } from "../../../../../../lib/analysis-jobs";
import { isPlainRecord, requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

function savedCheckpoint(value: string | null | undefined): Record<string, unknown> {
  try { const parsed = JSON.parse(value ?? "null") as unknown; return isPlainRecord(parsed) ? parsed : {}; }
  catch { return {}; }
}

function losesProgress(previous: Record<string, unknown>, next: Record<string, unknown>, previousStage: string | null | undefined, nextStage: string) {
  if (nextStage === "transcript_ready" && previousStage !== "transcript_ready") return true;
  const priorUnified = previous.unified_progress, nextUnified = next.unified_progress;
  if (isPlainRecord(priorUnified)) {
    if (!isPlainRecord(nextUnified)) return true;
    if (priorUnified.source_signature && priorUnified.source_signature !== nextUnified.source_signature) return true;
    if (isPlainRecord(priorUnified.canonical) && !isPlainRecord(nextUnified.canonical)) return true;
    const before = isPlainRecord(priorUnified.modules) ? priorUnified.modules : {};
    const after = isPlainRecord(nextUnified.modules) ? nextUnified.modules : {};
    for (const [key, value] of Object.entries(before)) if (isPlainRecord(value) && value.status === "completed") {
      const replacement = after[key];
      if (!isPlainRecord(replacement) || replacement.status !== "completed") return true;
    }
  }
  if (isPlainRecord(previous.segment_progress)) {
    if (!isPlainRecord(next.segment_progress)) return true;
    const before = Array.isArray(previous.segment_progress.segments) ? previous.segment_progress.segments : [];
    const after = Array.isArray(next.segment_progress.segments) ? next.segment_progress.segments : [];
    const completed = new Set(after.filter(row => isPlainRecord(row) && row.status === "completed").map(row => (row as Record<string, unknown>).window_key));
    if (before.some(row => isPlainRecord(row) && row.status === "completed" && !completed.has(row.window_key))) return true;
  }
  return false;
}

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = parseCheckpointPayload(await request.json());
    if (!payload) return apiError("INVALID_ANALYSIS_CHECKPOINT", "分析检查点格式无效或体积超限。", 400);
    const { jobId } = await context.params; const db = getD1();
    const executionColumn = payload.attempt === null ? "version" : "attempt_count";
    const executionValue = payload.attempt ?? payload.version;
    const transcript = payload.stage === "transcript_ready" ? readTranscriptCheckpoint(payload.checkpoint) : null;
    const sourceGuard = `EXISTS(SELECT 1 FROM media_assets m INNER JOIN videos v ON v.id=m.video_id AND v.organization_id=m.organization_id AND v.project_id=m.project_id
      WHERE m.id=? AND m.organization_id=analysis_jobs.organization_id AND m.project_id=analysis_jobs.project_id AND m.video_id=analysis_jobs.video_id
        AND m.status='active' AND m.kind=? AND m.sha256=? AND m.size_bytes=? AND v.deleted_at IS NULL
        AND (m.analysis_job_id=analysis_jobs.id OR (analysis_jobs.source_type='upload' AND m.id=analysis_jobs.source_ref AND m.id=v.media_asset_id)))`;
    const sourceBindings = transcript ? [transcript.assetId, transcript.kind, transcript.sha256, transcript.sizeBytes] : [];
    // Re-read after a competing checkpoint write; heartbeats may advance their
    // revision independently and must not invalidate this execution's evidence.
    for (let retry = 0; retry < 3; retry += 1) {
      const now = new Date().toISOString();
      const job = await db.prepare(`
        SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.progress, j.current_stage,
          j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key, j.checkpoint_stage, j.checkpoint_json
        FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
        WHERE j.id = ? AND v.deleted_at IS NULL
      `).bind(jobId).first<WorkerJobRow>();
      if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
      if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= now) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
      if (job[executionColumn] !== executionValue) return apiError("JOB_VERSION_CONFLICT", "任务执行轮次已发生变化。", 409);
      if (!(payload.stage === "transcript_ready" ? ["transcribing", "extracting", "analyzing"] : ["extracting", "analyzing"]).includes(job.status)) return apiError("CHECKPOINT_STAGE_INVALID", "当前任务阶段不能保存分析检查点。", 409);
      if (transcript && !await db.prepare(`SELECT 1 FROM analysis_jobs WHERE id=? AND ${sourceGuard}`).bind(jobId, ...sourceBindings).first()) return apiError("TRANSCRIPT_SOURCE_MISMATCH", "转写检查点必须绑定当前任务已保存且完整的原片。", 409);
      const previous = savedCheckpoint(job.checkpoint_json), receipt = previous._write_fence;
      // Only the server attributes a stored snapshot to an execution. A new
      // attempt may rebuild caches; older snapshots in this attempt may not.
      const sameAttempt = isPlainRecord(receipt) ? receipt.attempt === job.attempt_count : ["evidence_ready", "segment_progress"].includes(job.checkpoint_stage ?? "") && payload.stage === "transcript_ready";
      if (sameAttempt && losesProgress(previous, payload.checkpoint, job.checkpoint_stage, payload.stage)) return Response.json({ checkpoint: { stage: job.checkpoint_stage }, superseded: true });
      const checkpointJson = JSON.stringify({ ...payload.checkpoint, _write_fence: { attempt: job.attempt_count } });
      if (checkpointJson.length > 1_000_000) return apiError("INVALID_ANALYSIS_CHECKPOINT", "分析检查点体积超限。", 400);
      const result = await db.prepare(`
      UPDATE analysis_jobs SET checkpoint_stage = ?, checkpoint_json = ?, checkpoint_updated_at = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND ${executionColumn} = ? AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND status IN (${LEASED_ANALYSIS_STATUSES_SQL}) AND EXISTS(SELECT 1 FROM videos v WHERE v.id=analysis_jobs.video_id AND v.organization_id=analysis_jobs.organization_id AND v.project_id=analysis_jobs.project_id AND v.deleted_at IS NULL)
        AND checkpoint_json IS ? AND checkpoint_stage IS ? ${transcript ? `AND ${sourceGuard}` : ""}
      `).bind(payload.stage, checkpointJson, now, `service:${payload.workerId}`, now, jobId, payload.workerId, executionValue, job.checkpoint_json ?? null, job.checkpoint_stage ?? null, ...sourceBindings).run();
      if (result.meta.changes) return Response.json({ checkpoint: { stage: payload.stage, updatedAt: now } }, { status: 201 });
    }
    return apiError("CHECKPOINT_WRITE_CONFLICT", "检查点正在并发更新，已保留当前恢复进度。", 409);
  } catch (error) { return errorResponse(error); }
}
