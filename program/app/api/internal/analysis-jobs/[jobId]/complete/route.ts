import { isAnalysisCollectionMode } from "../../../../../../lib/analysis-collection-mode";
import { isAnalysisExecutionMode } from "../../../../../../lib/analysis-execution-mode";
import { matchesVisualSamplingLevel } from "../../../../../../lib/visual-sampling-level";
import { isVisualAnalysisMode, normalizeVisualAnalysisMode } from "../../../../../../lib/visual-analysis-mode";
import { readEvidenceCheckpoint, parseAnalysisModuleRetryKeys } from "../../../../../../lib/analysis-module-retry";
import { getD1 } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { parseCompletionPayload, readTranscriptCheckpoint, type WorkerJobRow } from "../../../../../../lib/analysis-worker";
import { isPlainRecord, requireAnalyzerService } from "../../../../../../lib/service-auth";
import { extractVideoKnowledgeAtoms } from "../../../../../../lib/video-knowledge-atoms";
import { enqueueBenchmarkVideoAnalysisMemoryEventsWithDb } from "../../../../../../lib/benchmark-memory-events";
import type { ProjectAssistantDatabase } from "../../../../../../lib/project-memory-events";
import { assessAnalysisQuality, analysisCompletionMessage } from "../../../../../../lib/analysis-quality";

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
      SELECT j.id, j.organization_id, j.project_id, j.video_id, j.input_transcript_id, j.idempotency_key, j.transcript_review_enabled, j.visual_analysis_mode, j.visual_sampling_level, j.status, j.progress, j.current_stage, j.lease_owner, j.lease_expires_at, j.attempt_count, j.version, j.result_key, j.checkpoint_stage, j.checkpoint_json
      FROM analysis_jobs j INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id
      WHERE j.id = ?
    `).bind(jobId).first<WorkerJobRow & { input_transcript_id: string | null; idempotency_key: string; transcript_review_enabled: number; visual_analysis_mode: string; visual_sampling_level: string | null }>();
    if (!job) return apiError("JOB_NOT_FOUND", "分析任务不存在。", 404);
    const transcriptOnly = job.idempotency_key.startsWith("transcript:");
    if (transcriptOnly !== (payload.analysis.schemaVersion === "transcript.v1")) {
      return apiError("JOB_RESULT_TYPE_MISMATCH", "结果类型与领取的任务不符。", 409);
    }
    if ((job.status === "completed" || job.status === "partial") && job.result_key === payload.resultKey) {
      return Response.json({ job: { id: jobId, status: job.status, version: job.version }, idempotent: true });
    }
    if (job.status !== (transcriptOnly ? "extracting" : "analyzing")) return apiError("INVALID_STATUS_TRANSITION", "只有分析中的任务可以提交最终结果。", 409);
    if (job.lease_owner !== payload.workerId || !job.lease_expires_at || job.lease_expires_at <= nowIso) return apiError("LEASE_NOT_OWNED", "当前 Worker 不再持有有效租约。", 409);
    if (job.version !== payload.version) return apiError("JOB_VERSION_CONFLICT", "任务版本已发生变化。", 409);

    if (transcriptOnly) {
      const transcript = payload.transcript;
      if (!transcript?.fullText.trim() || transcript.segmentsJson === "[]" || payload.analysis.reportJson !== "{}") {
        return apiError("INVALID_TRANSCRIPT_RESULT", "没有收到完整口播稿及其分段。", 400);
      }
      const actor = `service:${payload.workerId}`;
      const stage = "完整口播稿已提取";
      const transcriptId = crypto.randomUUID();
      const finalVersion = payload.version + 1;
      // Fence the transcript insert before changing the job, so concurrent deliveries cannot duplicate it.
      const results = await db.batch([
        db.prepare(`INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source,
            full_text, segments_json, confidence, created_by, created_at, updated_at)
          SELECT ?, j.organization_id, j.project_id, j.video_id, (SELECT COALESCE(MAX(version), 0) + 1 FROM video_transcripts WHERE video_id=j.video_id),
            ?, 'asr', ?, ?, ?, ?, ?, ? FROM analysis_jobs j
          WHERE j.id=? AND j.status='extracting' AND j.lease_owner=? AND j.version=? AND j.lease_expires_at>?
            AND EXISTS (SELECT 1 FROM videos v WHERE v.id=j.video_id AND v.organization_id=j.organization_id AND v.project_id=j.project_id AND v.deleted_at IS NULL)`)
          .bind(transcriptId, transcript.language, transcript.fullText, transcript.segmentsJson, transcript.confidence,
            actor, nowIso, nowIso, jobId, payload.workerId, payload.version, nowIso),
        db.prepare(`UPDATE analysis_jobs SET status='completed', progress=100, current_stage=?, error_code=NULL, error_message=NULL,
            completed_at=?, last_progress_at=?, lease_owner=NULL, lease_expires_at=NULL, result_key=?, checkpoint_stage=NULL,
            checkpoint_json=NULL, checkpoint_updated_at=NULL, version=version+1, updated_by=?, updated_at=?
          WHERE EXISTS(SELECT 1 FROM video_transcripts WHERE id=?) AND id=? AND status='extracting' AND lease_owner=? AND version=? AND lease_expires_at>?`)
          .bind(stage, nowIso, nowIso, payload.resultKey, actor, nowIso, transcriptId, jobId, payload.workerId, payload.version, nowIso),
        db.prepare(`INSERT INTO analysis_job_events (id, organization_id, project_id, job_id, video_id, event_type, from_status, to_status,
            progress, worker_id, details_json, created_at)
          SELECT ?, organization_id, project_id, id, video_id, 'completed', 'extracting', 'completed', 100, ?, ?, ?
          FROM analysis_jobs WHERE EXISTS(SELECT 1 FROM video_transcripts WHERE id=?) AND id=? AND result_key=? AND version=?`)
          .bind(crypto.randomUUID(), payload.workerId, JSON.stringify({ schemaVersion: "transcript.v1", hasTranscript: true }), nowIso, transcriptId, jobId, payload.resultKey, finalVersion),
      ]);
      if (!results[1].meta.changes) return apiError("JOB_STATE_CHANGED", "任务状态已变化，未保存口播稿。", 409);
      return Response.json({ job: { id: jobId, status: "completed", progress: 100, version: finalVersion, message: stage }, idempotent: false });
    }

    const report = JSON.parse(payload.analysis.reportJson) as unknown;
    const analysisMeta = isPlainRecord(report) && isPlainRecord(report.analysis_meta) ? report.analysis_meta : null;
    const recordedVisualMode = analysisMeta?.visual_analysis_mode;
    if ((recordedVisualMode !== undefined && !isVisualAnalysisMode(recordedVisualMode))
      || normalizeVisualAnalysisMode(recordedVisualMode) !== normalizeVisualAnalysisMode(job.visual_analysis_mode)) {
      return apiError("VISUAL_ANALYSIS_MODE_MISMATCH", "分析结果与提交时选择的画面分析模式不一致，请更新分析服务后重试。", 409);
    }
    if (analysisMeta?.collection_mode !== undefined && !isAnalysisCollectionMode(analysisMeta.collection_mode)) return apiError("INVALID_ANALYSIS_COLLECTION_MODE", "报告采集方式无效。", 400);
    if (analysisMeta?.execution_mode !== undefined && !isAnalysisExecutionMode(analysisMeta.execution_mode)) return apiError("INVALID_ANALYSIS_EXECUTION_MODE", "报告执行方式无效。", 400);
    if (!matchesVisualSamplingLevel(analysisMeta?.visual_sampling_level, job.visual_sampling_level)) {
      return apiError("VISUAL_SAMPLING_LEVEL_MISMATCH", "分析结果与提交时选择的画面采样档位不一致，请更新分析服务后重试。", 409);
    }
    if (job.transcript_review_enabled === 0
      ? payload.analysis.schemaVersion !== "analysis.v12" || analysisMeta?.transcript_review_enabled !== false
      : analysisMeta?.transcript_review_enabled === false) {
      return apiError("TRANSCRIPT_REVIEW_MODE_MISMATCH", "分析结果与提交时选择的口播采用方式不一致，请更新分析服务后重试。", 409);
    }
    if (job.transcript_review_enabled === 0 && !job.input_transcript_id) {
      const unified = isPlainRecord(report) && isPlainRecord(report.unified_report) ? report.unified_report : null;
      const outcome = unified && isPlainRecord(unified.outcome) ? unified.outcome : null;
      if (!outcome || !["original", "not_applicable"].includes(String(outcome.manuscript))) {
        return apiError("TRANSCRIPT_REVIEW_MODE_MISMATCH", "原始转写任务不能保存自动校正的稿件，请更新分析服务后重试。", 409);
      }
    }
    if (job.transcript_review_enabled === 0 && job.input_transcript_id && analysisMeta?.transcript_source_kind !== "manual") {
      return apiError("TRANSCRIPT_REVIEW_MODE_MISMATCH", "本次任务应使用已保存的人工校正版，未接收其他来源的稿件。", 409);
    }
    const qualityAudit = analysisMeta && isPlainRecord(analysisMeta.quality_audit) ? analysisMeta.quality_audit : null;
    const quality = assessAnalysisQuality(payload.analysis.schemaVersion, report);
    const finalStatus: "completed" | "partial" = quality.accepted ? "completed" : "partial";
    const qualityIssues = quality.issues;
    const completionMessage = analysisCompletionMessage(payload.analysis.schemaVersion, report, quality);
    const partialMessage = finalStatus === "partial" ? completionMessage : null;
    let partialCheckpointStage: "transcript_ready" | "evidence_ready" | "segment_progress" | null = null;
    let partialCheckpointJson: string | null = null;
    if ((finalStatus === "partial" || quality.manuscriptStatus === "needs_review") && job.checkpoint_json) {
      try {
        const checkpoint = JSON.parse(job.checkpoint_json) as unknown;
        if (
          isPlainRecord(checkpoint)
          && checkpoint.checkpoint_version === 1
          && isPlainRecord(checkpoint.media)
          && isPlainRecord(checkpoint.transcript)
          && isPlainRecord(checkpoint.visuals)
        ) {
          // Report-only revalidation applies to this attempt, never to a later repair.
          delete checkpoint.report_revalidation_only;
          const previousSpokenScriptSet = isPlainRecord(report) && isPlainRecord(report.spoken_script_set)
            ? report.spoken_script_set
            : {};
          const augmented = JSON.stringify({
            ...checkpoint,
            previous_spoken_script_set: previousSpokenScriptSet,
            retry_script_version: null,
            retry_module_keys: null,
            retry_review_segment_ids: null,
          });
          if (augmented.length <= 1_000_000) {
            partialCheckpointStage = job.checkpoint_stage === "segment_progress" ? "segment_progress" : "evidence_ready";
            partialCheckpointJson = augmented;
          }
        } else if (job.checkpoint_stage === "transcript_ready" && readTranscriptCheckpoint(checkpoint)) {
          // A failed evidence-checkpoint write must not erase the earlier paid ASR.
          partialCheckpointStage = "transcript_ready";
          partialCheckpointJson = job.checkpoint_json;
        }
      } catch {
        partialCheckpointStage = null;
        partialCheckpointJson = null;
      }
    }
    const finalStage = finalStatus === "completed" ? quality.reviewSegmentCount ? `分析完成，${quality.reviewSegmentCount}句口播待核对` : "分析完成" : "分析部分完成，等待复核或重试";
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
          platform_work_id = COALESCE(platform_work_id, ?),
          title = COALESCE(title, ?),
          author_name = COALESCE(?, author_name),
          published_at = CASE WHEN published_at_source = 'tikhub' THEN published_at ELSE COALESCE(?, published_at) END,
          duration_sec = COALESCE(?, duration_sec),
          updated_by = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND project_id = ?
          AND (? IS NULL OR platform_work_id IS NULL OR platform_work_id = ?)
          AND EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.id = ? AND j.video_id = videos.id AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?)
      `).bind(source.platformWorkId, source.title, source.authorName, source.publishedAt, source.durationSec, actor, nowIso, job.video_id, job.organization_id, job.project_id, source.platformWorkId, source.platformWorkId, jobId, payload.resultKey, finalVersion));
      if (Object.values(source.metrics).some((value) => value !== null)) {
        statements.push(db.prepare(`
          INSERT INTO video_metric_snapshots (id, organization_id, project_id, video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_by, created_at)
          SELECT ?, j.organization_id, j.project_id, j.video_id, 'public', ?, ?, ?, ?, ?, NULL, ?, ?, ?
          FROM analysis_jobs j JOIN videos v ON v.id=j.video_id AND (? IS NULL OR v.platform_work_id IS NULL OR v.platform_work_id=?)
          WHERE j.id = ? AND j.status IN ('completed', 'partial') AND j.result_key = ? AND j.version = ?
        `).bind(crypto.randomUUID(), source.metrics.plays, source.metrics.likes, source.metrics.comments, source.metrics.favorites, source.metrics.shares, nowIso, actor, nowIso, source.platformWorkId, source.platformWorkId, jobId, payload.resultKey, finalVersion));
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
        .bind(crypto.randomUUID(), finalStatus, job.status, finalStatus, payload.workerId, JSON.stringify({ schemaVersion: payload.analysis.schemaVersion, hasTranscript: Boolean(payload.transcript), hasSourceMetadata: Boolean(payload.sourceMetadata), qualityAuditStatus: qualityAudit?.status ?? null, qualityIssues, reviewSegmentCount: quality.reviewSegmentCount ?? 0, manuscriptStatus: quality.manuscriptStatus ?? null, message: completionMessage }), nowIso, jobId, payload.resultKey, finalVersion),
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
    return Response.json({ job: { id: jobId, status: finalStatus, progress: 100, version: finalVersion, reviewSegmentCount: quality.reviewSegmentCount ?? 0, manuscriptStatus: quality.manuscriptStatus ?? null, message: completionMessage }, idempotent: false });
  } catch (error) {
    return errorResponse(error);
  }
}
