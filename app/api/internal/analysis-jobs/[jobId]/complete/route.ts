import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseCompletionPayload, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { requireAnalyzerService } from "../../../../../../lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request); if ("error" in service) return service.error;
  try {
    const payload = parseCompletionPayload(await request.json()); if (!payload) return apiError("INVALID_ANALYSIS_RESULT", "分析结果格式无效或体积超限。", 400);
    const { jobId } = await context.params; const db = getD1(); const nowIso = new Date().toISOString();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.status, j.progress, j.current_stage, j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    if (job.status === "completed" && job.result_key === payload.resultKey) return Response.json({ job: { id: jobId, status: "completed", version: job.version }, idempotent: true });
    if (job.status !== "analyzing") return apiError("INVALID_STATUS_TRANSITION", "只有分析中的任务可以提交最终结果。", 409);
    if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= nowIso) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
    if (job.version !== payload.version) return apiError("JOB_VERSION_CONFLICT", "任务版本已发生变化。", 409);

    const actor = `service:${payload.workerId}`; const finalVersion = payload.version + 1; const statements = [
      db.prepare("UPDATE analysis_jobs SET status = 'completed', progress = 100, current_stage = '分析完成', error_code = NULL, error_message = NULL, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL, result_key = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'analyzing' AND lease_owner = ? AND version = ? AND lease_expires_at > ?")
        .bind(nowIso, payload.resultKey, actor, nowIso, jobId, payload.workerId, payload.version, nowIso),
    ];
    if (payload.transcript) {
      statements.push(db.prepare(`
        INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source, full_text, segments_json, confidence, created_by, created_at, updated_at)
        SELECT ?, j.organization_id, j.project_id, j.video_id, (SELECT COALESCE(MAX(t.version), 0) + 1 FROM video_transcripts t WHERE t.video_id = j.video_id), ?, 'asr', ?, ?, ?, ?, ?, ?
        FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
        WHERE j.id = ? AND j.status = 'completed' AND j.result_key = ? AND j.version = ?
      `).bind(crypto.randomUUID(), payload.transcript.language, payload.transcript.fullText, payload.transcript.segmentsJson, payload.transcript.confidence, actor, nowIso, nowIso, jobId, payload.resultKey, finalVersion));
    }
    statements.push(
      db.prepare(`
        INSERT INTO video_analyses (id, organization_id, project_id, video_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_by, created_at, updated_at)
        SELECT ?, j.organization_id, j.project_id, j.video_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
        WHERE j.id = ? AND j.status = 'completed' AND j.result_key = ? AND j.version = ?
      `).bind(crypto.randomUUID(), payload.analysis.schemaVersion, payload.analysis.reportJson, payload.analysis.confidence, payload.analysis.modelProvider, payload.analysis.modelName, payload.analysis.promptVersion, actor, nowIso, nowIso, jobId, payload.resultKey, finalVersion),
      db.prepare("UPDATE videos SET status = 'ready', error_message = NULL, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.id = ? AND j.video_id = videos.id AND j.status = 'completed' AND j.result_key = ? AND j.version = ?)")
        .bind(actor, nowIso, job.video_id, job.organization_id, job.project_id, jobId, payload.resultKey, finalVersion),
      db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, worker_id, details_json, created_at) SELECT ?, organization_id, project_id, id, video_id, 'completed', ?, 'completed', 100, ?, ?, ? FROM analysis_jobs WHERE id = ? AND result_key = ? AND version = ?")
        .bind(crypto.randomUUID(), job.status, payload.workerId, JSON.stringify({ schemaVersion: payload.analysis.schemaVersion, hasTranscript: Boolean(payload.transcript) }), nowIso, jobId, payload.resultKey, finalVersion),
    );
    const results = await db.batch(statements); if (!results[0].meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，结果未写入。", 409);
    return Response.json({ job: { id: jobId, status: "completed", progress: 100, version: finalVersion }, idempotent: false });
  } catch (error) { return errorResponse(error); }
}
