import { normalizeVisualSamplingLevel, readVisualSamplingLevel, type VisualSamplingLevel } from "./visual-sampling-level.ts";
import { normalizeNewVisualAnalysisMode, normalizeVisualAnalysisMode, type VisualAnalysisMode } from "./visual-analysis-mode.ts";
import { apiError } from "./api-response.ts";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition } from "./project-write-access.ts";

type Submission = {
  organizationId: string; projectId: string; userId: string; now: string;
  sourceType: "url" | "upload"; sourceHash: string; sourceUrl?: string; filename?: string;
  transcriptReviewEnabled?: boolean; visualAnalysisMode?: VisualAnalysisMode; visualSamplingLevel?: VisualSamplingLevel;
};
type Database = Pick<D1Database, "prepare" | "batch">;

/** Reusing existing media never needs a running analyzer or consumes a new analysis quota. */
export async function resolveVideoSubmission(db: Database, input: Submission, validateNew: () => Promise<Response | null>, assertAccess?: () => Promise<void>) {
  const { organizationId, projectId, sourceHash, sourceUrl, sourceType, userId, now } = input;
  const duplicate = await db.prepare(`SELECT id FROM videos WHERE organization_id = ? AND project_id = ?
    AND (source_hash = ? OR (? IS NOT NULL AND source_url = ?)) AND deleted_at IS NULL`)
    .bind(organizationId, projectId, sourceHash, sourceUrl ?? null, sourceUrl ?? null).first<{ id: string }>();
  if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", sourceType === "url" ? "该链接已经进入当前项目。" : "相同媒体已经进入当前项目。", 409, { videoId: duplicate.id });
  const canonical = await db.prepare(`
    SELECT library.id AS library_entry_id, v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.created_at, a.filename, a.size_bytes,
      job.id AS job_id, job.status AS job_status, job.progress, job.current_stage, job.error_code, job.error_message, job.retry_count, job.analysis_profile, job.transcript_review_enabled, job.visual_analysis_mode, job.visual_sampling_level, job.created_at AS job_created_at, job.updated_at AS job_updated_at,
      (SELECT report_job.transcript_review_enabled FROM video_analyses analysis INNER JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
        AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
        WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1) AS report_transcript_review_enabled,
      (SELECT report_job.visual_analysis_mode FROM video_analyses analysis INNER JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
        AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
        WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1) AS report_visual_analysis_mode,
      (SELECT analysis.id FROM video_analyses analysis WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1) AS report_id,
      (SELECT CASE WHEN report_job.id IS NOT NULL THEN report_job.visual_sampling_level WHEN json_valid(analysis.report_json) THEN json_extract(analysis.report_json,'$.analysis_meta.visual_sampling_level') ELSE NULL END FROM video_analyses analysis LEFT JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
        AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
        WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1) AS report_visual_sampling_level
    FROM video_library_entries library
    INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
    LEFT JOIN media_assets a ON a.id = v.media_asset_id
    LEFT JOIN analysis_jobs job ON job.id = (SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id AND latest.idempotency_key NOT LIKE 'transcript:%' ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
    WHERE library.organization_id = ? AND v.deleted_at IS NULL AND (v.source_hash = ? OR (? IS NOT NULL AND v.source_url = ?))
    LIMIT 1
  `).bind(organizationId, sourceHash, sourceUrl ?? null, sourceUrl ?? null).first<Record<string, unknown>>();
  if (!canonical) return validateNew();
  if ((canonical.transcript_review_enabled !== 0) !== (input.transcriptReviewEnabled !== false)
    || canonical.report_transcript_review_enabled != null && (canonical.report_transcript_review_enabled !== 0) !== (input.transcriptReviewEnabled !== false)) {
    return apiError("TRANSCRIPT_REVIEW_OPTION_MISMATCH", "该素材已有不同口播稿 AI 核对设置的分析。请在原素材所在项目按所需设置重新分析，或选择一致的核对设置后复用。", 409, { videoId: canonical.id, transcriptReviewEnabled: canonical.transcript_review_enabled !== 0 });
  }
  const visualAnalysisMode = normalizeNewVisualAnalysisMode(input.visualAnalysisMode);
  if (normalizeVisualAnalysisMode(canonical.visual_analysis_mode) !== visualAnalysisMode
    || canonical.report_visual_analysis_mode != null && normalizeVisualAnalysisMode(canonical.report_visual_analysis_mode) !== visualAnalysisMode) {
    return apiError("VISUAL_ANALYSIS_MODE_MISMATCH", "该素材已有不同画面分析模式的结果。请在原素材所在项目按所需模式重新分析，或选择一致的模式后复用。", 409, { videoId: canonical.id, visualAnalysisMode: normalizeVisualAnalysisMode(canonical.visual_analysis_mode) });
  }
  const visualSamplingLevel = normalizeVisualSamplingLevel(input.visualSamplingLevel);
  if (readVisualSamplingLevel(canonical.visual_sampling_level) !== visualSamplingLevel
    || canonical.report_id != null && readVisualSamplingLevel(canonical.report_visual_sampling_level) !== visualSamplingLevel) {
    return apiError("VISUAL_SAMPLING_LEVEL_MISMATCH", "该素材已有不同采样档位或历史采样方案的分析。请在原素材所在项目按所需档位重新分析后再复用。", 409, { videoId: canonical.id, visualSamplingLevel: readVisualSamplingLevel(canonical.visual_sampling_level) });
  }
  const libraryEntryId = String(canonical.library_entry_id);
  const existing = await db.prepare("SELECT id,status FROM project_video_references WHERE organization_id=? AND project_id=? AND library_entry_id=? AND purpose='analysis'").bind(organizationId, projectId, libraryEntryId).first<{ id: string; status: string }>();
  const reference = { id: existing?.id ?? crypto.randomUUID(), action: !existing ? "created" : existing.status === "revoked" ? "reactivated" : "already_active" };
  const origin = sourceType === "url" ? { sourceUrl } : { filename: input.filename };
  await assertAccess?.();
  const sourceCondition = `EXISTS (SELECT 1 FROM video_library_entries library INNER JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id
    WHERE library.id=? AND library.organization_id=? AND v.deleted_at IS NULL AND COALESCE((SELECT j.transcript_review_enabled FROM analysis_jobs j
      WHERE j.organization_id=v.organization_id AND j.video_id=v.id AND j.idempotency_key NOT LIKE 'transcript:%'
      ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1),1)=? AND COALESCE((SELECT report_job.transcript_review_enabled
        FROM video_analyses analysis INNER JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
          AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
        WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1),?)=?
      AND COALESCE((SELECT j.visual_analysis_mode FROM analysis_jobs j WHERE j.organization_id=v.organization_id AND j.video_id=v.id
        AND j.idempotency_key NOT LIKE 'transcript:%' ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1),'hybrid')=?
      AND COALESCE((SELECT report_job.visual_analysis_mode FROM video_analyses analysis INNER JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
        AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
        WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1),?)=?
      AND (SELECT j.visual_sampling_level FROM analysis_jobs j WHERE j.organization_id=v.organization_id AND j.video_id=v.id
        AND j.idempotency_key NOT LIKE 'transcript:%' ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) IS ?
      AND (NOT EXISTS(SELECT 1 FROM video_analyses analysis WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id)
        OR (SELECT CASE WHEN report_job.id IS NOT NULL THEN report_job.visual_sampling_level WHEN json_valid(analysis.report_json) THEN json_extract(analysis.report_json,'$.analysis_meta.visual_sampling_level') ELSE NULL END FROM video_analyses analysis LEFT JOIN analysis_jobs report_job ON report_job.id=analysis.analysis_job_id
          AND report_job.organization_id=analysis.organization_id AND report_job.video_id=analysis.video_id
          WHERE analysis.organization_id=v.organization_id AND analysis.video_id=v.id ORDER BY analysis.created_at DESC,analysis.rowid DESC LIMIT 1) IS ?))`;
  const reviewValue = input.transcriptReviewEnabled === false ? 0 : 1;
  const sourceConditionBindings = [libraryEntryId, organizationId, reviewValue, reviewValue, reviewValue, visualAnalysisMode, visualAnalysisMode, visualAnalysisMode, visualSamplingLevel, visualSamplingLevel];
  const results = await db.batch([
    db.prepare(`INSERT INTO project_video_references (id,organization_id,project_id,library_entry_id,purpose,status,created_by,created_at)
      SELECT ?,?,?,?,'analysis','active',?,? WHERE ${projectWriteAccessCondition} AND ${sourceCondition}
      ON CONFLICT(project_id,library_entry_id,purpose) DO UPDATE SET status='active',revoked_by=NULL,revoked_at=NULL,revoke_reason=NULL`)
      .bind(reference.id, organizationId, projectId, libraryEntryId, userId, now, ...projectWriteAccessBindings(input), ...sourceConditionBindings),
    db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?,?,?,?,'video.analysis_reused','video_library_entry',?,?,? WHERE ${projectWriteAccessCondition} AND ${sourceCondition}
      AND EXISTS(SELECT 1 FROM project_video_references WHERE organization_id=? AND project_id=? AND library_entry_id=? AND purpose='analysis' AND status='active')`)
      .bind(crypto.randomUUID(), organizationId, projectId, userId, libraryEntryId, JSON.stringify({ ...origin, sourceVideoId: canonical.id, referenceAction: reference.action }), now, ...projectWriteAccessBindings(input), ...sourceConditionBindings, organizationId, projectId, libraryEntryId),
  ]);
  if (!results[0].meta.changes) {
    await assertProjectWriteAccess(db, input);
    return apiError("VIDEO_LIBRARY_SOURCE_CHANGED", "共享素材已删除或不可用，本次没有导入。请刷新素材库后再选择。", 409);
  }
  return Response.json({
    reused: true, referenceAction: reference.action,
    video: { id: canonical.id, platform: canonical.platform, source_type: canonical.source_type, title: canonical.title, author_name: canonical.author_name, status: canonical.status, created_at: canonical.created_at, is_reference: true, library_entry_id: canonical.library_entry_id,
      ...(sourceType === "url" ? { source_url: canonical.source_url } : { filename: canonical.filename, size_bytes: canonical.size_bytes }) },
    job: canonical.job_id
      ? { id: canonical.job_id, video_id: canonical.id, status: canonical.job_status, progress: canonical.progress, current_stage: canonical.current_stage, error_code: canonical.error_code, error_message: canonical.error_message, retry_count: canonical.retry_count, analysis_profile: canonical.analysis_profile, visual_analysis_mode: normalizeVisualAnalysisMode(canonical.visual_analysis_mode), visual_sampling_level: readVisualSamplingLevel(canonical.visual_sampling_level), transcript_review_enabled: canonical.transcript_review_enabled !== 0, created_at: canonical.job_created_at, updated_at: canonical.job_updated_at }
      : { id: `reused-${canonical.id}`, video_id: canonical.id, status: canonical.status === "ready" ? "completed" : "pending", progress: canonical.status === "ready" ? 100 : 0, current_stage: "复用公司素材库分析", retry_count: 0, analysis_profile: "shared", visual_analysis_mode: visualAnalysisMode, visual_sampling_level: visualSamplingLevel, created_at: canonical.created_at, updated_at: canonical.created_at },
  });
}

/** Returned statements join the caller's media transaction, so failures cannot leave half a submission. */
export function newVideoSubmissionStatements(db: Database, input: Submission & {
  videoId: string; jobId: string; title: string | null; mediaAssetId?: string;
  analysisProfile: string; auditMetadata: Record<string, unknown>;
}) {
  const { organizationId, projectId, videoId, jobId, userId, now, sourceType, sourceHash, analysisProfile } = input;
  const stage = sourceType === "url" ? "等待进入分析队列" : "媒体已入库，等待分析";
  const sourceRef = sourceType === "url" ? input.sourceUrl : input.mediaAssetId;
  if (!sourceRef) throw new Error("VIDEO_SOURCE_REQUIRED");
  const written = "EXISTS(SELECT 1 FROM videos WHERE id=? AND organization_id=? AND project_id=? AND created_by=?)";
  const writtenBindings = [videoId, organizationId, projectId, userId];
  return [
    db.prepare(`INSERT INTO videos (id, organization_id, project_id, media_asset_id, platform, source_type, source_url, source_hash, title, status, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ? WHERE ${projectWriteAccessCondition}`)
      .bind(videoId, organizationId, projectId, input.mediaAssetId ?? null, sourceType === "url" ? "douyin" : "upload", sourceType, input.sourceUrl ?? null, sourceHash, input.title, userId, userId, now, now, ...projectWriteAccessBindings(input)),
    db.prepare(`INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, 'other', '[]', ?, ?, ?, ? WHERE ${written}`)
      .bind(crypto.randomUUID(), organizationId, videoId, userId, userId, now, now, ...writtenBindings),
    db.prepare(`INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, source_type, source_ref, idempotency_key, status, analysis_profile, transcript_review_enabled, visual_analysis_mode, visual_sampling_level, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, 0, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${written}`)
      .bind(jobId, organizationId, projectId, videoId, sourceType, sourceRef, sourceHash, analysisProfile, input.transcriptReviewEnabled === false ? 0 : 1, normalizeNewVisualAnalysisMode(input.visualAnalysisMode), normalizeVisualSamplingLevel(input.visualSamplingLevel), stage, userId, userId, ...writtenBindings),
    db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'video', ?, ?, ? WHERE ${written}`)
      .bind(crypto.randomUUID(), organizationId, projectId, userId, sourceType === "url" ? "video.url_submitted" : "video.uploaded", videoId, JSON.stringify(input.auditMetadata), now, ...writtenBindings),
  ];
}
