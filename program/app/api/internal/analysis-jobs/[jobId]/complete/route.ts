import { readEvidenceCheckpoint, parseAnalysisModuleRetryKeys } from "../../../../../../lib/analysis-module-retry";
import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseCompletionPayload, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { isPlainRecord, requireAnalyzerService } from "../../../../../../lib/service-auth";
import { extractVideoKnowledgeAtoms } from "../../../../../../lib/video-knowledge-atoms";
import { enqueueBenchmarkVideoAnalysisMemoryEventsWithDb } from "../../../../../../lib/benchmark-memory-events";
import type { ProjectAssistantDatabase } from "../../../../../../lib/project-memory-events";
import { assessAnalysisQuality } from "../../../../../../lib/analysis-quality";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const service = await requireAnalyzerService(request);
  if ("error" in service) return service.error;
  try {
    const payload = parseCompletionPayload(await request.json());
    if (!payload) return apiError("INVALID_ANALYSIS_RESULT", "分析结果格式无效或体积超限。", 400);
    const { jobId } = await context.params;
    const db = getD1();
    const nowIso = new Date().toISOString();
    const job = await db.prepare(`
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.input_transcript_id, j.status, j.progress, j.current_stage, j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key, j.checkpoint_stage, j.checkpoint_json
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow & { input_transcript_id: string | null }>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    if ((job.status === "completed" || job.status === "partial") && job.result_key === payload.resultKey) {
      return Response.json({ job: { id: jobId, status: job.status, version: job.version }, idempotent: true });
    }
    if (job.status !== "analyzing") return apiError("INVALID_STATUS_TRANSITION", "只有分析中的任务可以提交最终结果。", 409);
    if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= nowIso) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
    if (job.version !== payload.version) return apiError("JOB_VERSION_CONFLICT", "任务版本已发生变化。", 409);

    const report = JSON.parse(payload.analysis.reportJson) as unknown;
    const analysisMeta = isPlainRecord(report) && isPlainRecord(report.analysis_meta) ? report.analysis_meta : null;
    const qualityAudit = analysisMeta && isPlainRecord(analysisMeta.quality_audit) ? analysisMeta.quality_audit : null;
    const quality = assessAnalysisQuality(payload.analysis.schemaVersion, report);
    const finalStatus: "completed" | "partial" = quality.accepted ? "completed" : "partial";
    const qualityIssues = quality.issues;
    const partialMessage = finalStatus === "partial"
      ? qualityIssues.length > 0
        ? `报告已生成，但有质量项未通过：${qualityIssues.slice(0, 3).join("；")}`
        : "报告已生成，但质量审计或契约校验未通过。"
      : null;
    let partialCheckpointStage: "evidence_ready" | "segment_progress" | null = null;
    let partialCheckpointJson: string | null = null;
    if (finalStatus === "partial" && job.checkpoint_json) {
      try {
        const checkpoint = JSON.parse(job.checkpoint_json) as unknown;
        if (
          isPlainRecord(checkpoint)
          && checkpoint.checkpoint_version === 1
          && isPlainRecord(checkpoint.media)
          && isPlainRecord(checkpoint.transcript)
          && isPlainRecord(checkpoint.visuals)
        ) {
          const previousSpokenScriptSet = isPlainRecord(report) && isPlainRecord(report.spoken_script_set)
            ? report.spoken_script_set
            : {};
          const augmented = JSON.stringify({
            ...checkpoint,
            previous_spoken_script_set: previousSpokenScriptSet,
            retry_script_version: null,
            retry_module_keys: null,
          });
          if (augmented.length <= 1_000_000) {
            partialCheckpointStage = job.checkpoint_stage === "segment_progress" ? "segment_progress" : "evidence_ready";
            partialCheckpointJson = augmented;
          }
        }
      } catch {
        partialCheckpointStage = null;
        partialCheckpointJson = null;
      }
    }
    const finalStage = finalStatus === "completed" ? "分析完成" : "分析部分完成，等待复核或重试";
    const actor = `service:${payload.workerId}`;
    const finalVersion = payload.version + 1;
    const analysisId = crypto.randomUUID();
    const statements = [
      db.prepare("UPDATE analysis_jobs SET status = ?, progress = 100, current_stage = ?, error_code = ?, error_message = ?, completed_at = ?, last_progress_at = ?, lease_owner = NULL, lease_expires_at = NULL, result_key = ?, checkpoint_stage = ?, checkpoint_json = ?, checkpoint_updated_at = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND status = 'analyzing' AND lease_owner = ? AND version = ? AND lease_expires_at > ?")
        .bind(finalStatus, finalStage, finalStatus === "partial" ? "ANALYSIS_PARTIAL" : null, partialMessage, nowIso, nowIso, payload.resultKey, partialCheckpointStage, partialCheckpointJson, partialCheckpointJson ? nowIso : null, actor, nowIso, jobId, payload.workerId, payload.version, nowIso),
    ];
    const resumedCheckpoint = readEvidenceCheckpoint(job.checkpoint_json);
    const reuseIdenticalRawTranscript = !job.input_transcript_id && Boolean(resumedCheckpoint && parseAnalysisModuleRetryKeys(resumedCheckpoint.retry_module_keys));
    if (payload.transcript) {
      statements.push(db.prepare(`
        INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source, full_text, segments_json, confidence, created_by, created_at, updated_at)
        SELECT ?, j.organization_id, j.project_id, j.video_id, (SELECT COALESCE(MAX(t.version), 0) + 1 FROM video_transcripts t WHERE t.video_id = j.video_id), ?, CASE WHEN j.input_transcript_id IS NULL THEN 'asr' ELSE 'manual' END, ?, ?, ?, ?, ?, ?
        FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
        WHERE j.id = ? AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?
          AND (? = 0 OR NOT EXISTS (SELECT 1 FROM video_transcripts t WHERE t.organization_id=j.organization_id AND t.project_id=j.project_id
            AND t.video_id=j.video_id AND t.source='asr' AND t.language=? AND t.full_text=? AND t.segments_json=? AND t.confidence IS ?))
      `).bind(crypto.randomUUID(), payload.transcript.language, payload.transcript.fullText, payload.transcript.segmentsJson, payload.transcript.confidence, actor, nowIso, nowIso, jobId, payload.resultKey, finalVersion,
        reuseIdenticalRawTranscript ? 1 : 0, payload.transcript.language, payload.transcript.fullText, payload.transcript.segmentsJson, payload.transcript.confidence));
    }
    if (payload.sourceMetadata) {
      const source = payload.sourceMetadata;
      statements.push(db.prepare(`
        UPDATE videos SET
          platform_work_id = COALESCE(?, platform_work_id),
          title = COALESCE(title, ?),
          author_name = COALESCE(?, author_name),
          published_at = COALESCE(?, published_at),
          duration_sec = COALESCE(?, duration_sec),
          updated_by = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND project_id = ?
          AND EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.id = ? AND j.video_id = videos.id AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?)
      `).bind(source.platformWorkId, source.title, source.authorName, source.publishedAt, source.durationSec, actor, nowIso, job.video_id, job.organization_id, job.project_id, jobId, payload.resultKey, finalVersion));
      if (Object.values(source.metrics).some((value) => value !== null)) {
        statements.push(db.prepare(`
          INSERT INTO video_metric_snapshots (id, organization_id, project_id, video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_by, created_at)
          SELECT ?, j.organization_id, j.project_id, j.video_id, 'public', ?, ?, ?, ?, ?, NULL, ?, ?, ?
          FROM analysis_jobs j
          WHERE j.id = ? AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?
        `).bind(crypto.randomUUID(), source.metrics.plays, source.metrics.likes, source.metrics.comments, source.metrics.favorites, source.metrics.shares, nowIso, actor, nowIso, jobId, payload.resultKey, finalVersion));
      }
    }
    statements.push(
      db.prepare(`
        INSERT INTO video_analyses (id, organization_id, project_id, video_id, analysis_job_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_by, created_at, updated_at)
        SELECT ?, j.organization_id, j.project_id, j.video_id, j.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
        WHERE j.id = ? AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?
      `).bind(analysisId, payload.analysis.schemaVersion, payload.analysis.reportJson, payload.analysis.confidence, payload.analysis.modelProvider, payload.analysis.modelName, payload.analysis.promptVersion, actor, nowIso, nowIso, jobId, payload.resultKey, finalVersion),
      db.prepare("UPDATE videos SET status = 'ready', error_message = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.id = ? AND j.video_id = videos.id AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?)")
        .bind(partialMessage, actor, nowIso, job.video_id, job.organization_id, job.project_id, jobId, payload.resultKey, finalVersion),
      db.prepare("INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status, progress, worker_id, details_json, created_at) SELECT ?, organization_id, project_id, id, video_id, ?, ?, ?, 100, ?, ?, ? FROM analysis_jobs WHERE id = ? AND result_key = ? AND version = ?")
        .bind(crypto.randomUUID(), finalStatus, job.status, finalStatus, payload.workerId, JSON.stringify({ schemaVersion: payload.analysis.schemaVersion, hasTranscript: Boolean(payload.transcript), hasSourceMetadata: Boolean(payload.sourceMetadata), qualityAuditStatus: qualityAudit?.status ?? null, qualityIssues }), nowIso, jobId, payload.resultKey, finalVersion),
    );
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，结果未写入。", 409);
    if (finalStatus === "completed") {
      try {
        await extractVideoKnowledgeAtoms({ organizationId: job.organization_id, videoId: job.video_id, analysisId, schemaVersion: payload.analysis.schemaVersion, reportJson: payload.analysis.reportJson, now: nowIso });
      } catch {
        /* Atom extraction is recoverable and does not invalidate an accepted report. */
      }
    }
    if (finalStatus === "completed") try {
      await enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(db as unknown as ProjectAssistantDatabase, {
        organizationId: job.organization_id,
        analysisId,
      });
    } catch (eventError) {
      console.error("project_memory_event_enqueue_failed", {
        jobId,
        analysisId,
        message: eventError instanceof Error ? eventError.message : "unknown",
      });
    }
    return Response.json({ job: { id: jobId, status: finalStatus, progress: 100, version: finalVersion }, idempotent: false });
  } catch (error) {
    return errorResponse(error);
  }
}
