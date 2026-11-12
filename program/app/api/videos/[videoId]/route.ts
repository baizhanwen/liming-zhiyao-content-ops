import { readAnalysisModuleRetryState } from "../../../../lib/analysis-module-retry";
import { manuscriptAssetForVersion } from "../../../../lib/manuscript-view";
import { readScopedAnalysisMedia } from "../../../../lib/analysis-media";
import { canAccessOrganizationVideoLibrary, canWriteProjectAccess, getD1, getOrganizationAccess, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { summarizeSegmentProgress } from "../../../../lib/analysis-segment-progress";
import { readRequestIdentity } from "../../../../lib/request-auth";

function parseStoredJson(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export async function GET(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问分析结果。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? ""; const requestedLibraryEntryId = url.searchParams.get("libraryEntryId")?.trim() ?? ""; const requestedAnalysisId = url.searchParams.get("analysisId")?.trim() ?? "";
  if (requestedAnalysisId.length > 200) return apiError("INVALID_ANALYSIS_VERSION", "分析版本无效。", 400);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的分析结果。", 403);
    const { videoId } = await context.params; const db = getD1();
    let sourceProjectId = projectId; let libraryEntryId: string | null = null; let sharedReference = false;
    let video: Record<string, unknown> | null = null;
    if (requestedLibraryEntryId) {
      const organization = await getOrganizationAccess(identity.authSubject, organizationId);
      const library = organization && await canAccessOrganizationVideoLibrary(organization) ? await db.prepare("SELECT library.id AS library_entry_id, v.project_id AS source_project_id FROM video_library_entries library INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.id = ? AND v.deleted_at IS NULL WHERE library.id = ? AND library.organization_id = ?").bind(videoId, requestedLibraryEntryId, organizationId).first<{ library_entry_id: string; source_project_id: string }>() : null;
      if (!library) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于公司素材库。", 404);
      sourceProjectId = library.source_project_id; libraryEntryId = library.library_entry_id; sharedReference = true;
      video = await db.prepare(`
        SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
          a.id AS local_media_asset_id, a.filename, a.content_type, a.size_bytes
        FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active' AND a.kind IN ('source_video', 'source_audio') AND (a.video_id IS NULL OR a.video_id = v.id)
        WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
      `).bind(videoId, organizationId, sourceProjectId).first<Record<string, unknown>>();
    } else {
      video = await db.prepare(`
      SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
        a.id AS local_media_asset_id, a.filename, a.content_type, a.size_bytes
      FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active' AND a.kind IN ('source_video', 'source_audio') AND (a.video_id IS NULL OR a.video_id = v.id)
      WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
    `).bind(videoId, organizationId, projectId).first<Record<string, unknown>>();
    }
    if (!video) {
      const reference = await db.prepare(`
        SELECT library.id AS library_entry_id, v.project_id AS source_project_id
        FROM project_video_references refs
        INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
        INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
        WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.status = 'active' AND refs.purpose = 'benchmark' AND v.id = ? AND v.deleted_at IS NULL
        LIMIT 1
      `).bind(organizationId, projectId, videoId).first<{ library_entry_id: string; source_project_id: string }>();
      if (!reference) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于当前项目。", 404);
      sourceProjectId = reference.source_project_id; libraryEntryId = reference.library_entry_id; sharedReference = true;
      video = await db.prepare(`
        SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
          a.id AS local_media_asset_id, a.filename, a.content_type, a.size_bytes
        FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active' AND a.kind IN ('source_video', 'source_audio') AND (a.video_id IS NULL OR a.video_id = v.id)
        WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
      `).bind(videoId, organizationId, sourceProjectId).first<Record<string, unknown>>();
    }
    if (!video) return apiError("VIDEO_NOT_FOUND", "视频素材源已不存在。", 404);
    if (!libraryEntryId) {
      libraryEntryId = (await db.prepare("SELECT id FROM video_library_entries WHERE organization_id = ? AND source_video_id = ? LIMIT 1").bind(organizationId, videoId).first<{ id: string }>())?.id ?? null;
    }
    if (requestedAnalysisId && !await db.prepare("SELECT id FROM video_analyses WHERE id = ? AND organization_id = ? AND project_id = ? AND video_id = ? LIMIT 1").bind(requestedAnalysisId, organizationId, sourceProjectId, videoId).first()) return apiError("ANALYSIS_NOT_FOUND", "指定的分析版本不存在或不在当前可访问的视频中。", 404);
    const canReadOwnedPerformance = !sharedReference || (Boolean(requestedLibraryEntryId) && projectId === sourceProjectId);
    const [latestJob, latestTranscript, analyses, metrics, events, assets, ownedPerformance] = await Promise.all([
      db.prepare("SELECT id, status, analysis_profile, progress, current_stage, error_code, error_message, retry_count, checkpoint_stage, checkpoint_json, checkpoint_updated_at, resume_count, created_at, updated_at, completed_at FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<Record<string, unknown>>(),
      db.prepare("SELECT id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY version DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<{ segments_json: string } & Record<string, unknown>>(),
      db.prepare(`SELECT id, analysis_job_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at FROM video_analyses WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY ${requestedAnalysisId ? "CASE WHEN id = ? THEN 0 ELSE 1 END, " : ""}created_at DESC, rowid DESC LIMIT 8`).bind(organizationId, sourceProjectId, videoId, ...(requestedAnalysisId ? [requestedAnalysisId] : [])).all<{ id: string; analysis_job_id: string | null; schema_version: string; created_at: string; report_json: string } & Record<string, unknown>>(),
      db.prepare("SELECT source, plays, likes, comments, favorites, shares, followers_gained, collected_at FROM video_metric_snapshots WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY collected_at DESC LIMIT 10").bind(organizationId, sourceProjectId, videoId).all(),
      db.prepare("SELECT event_type, from_status, to_status, progress, details_json, created_at FROM analysis_job_events WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 50").bind(organizationId, sourceProjectId, videoId).all(),
      db.prepare("SELECT id, analysis_job_id, kind, filename, content_type, size_bytes, created_at FROM media_assets WHERE organization_id = ? AND project_id = ? AND video_id = ? AND kind IN ('keyframe', 'subtitle', 'report') AND status = 'active' ORDER BY created_at ASC,rowid ASC").bind(organizationId, sourceProjectId, videoId).all<{ id: string; analysis_job_id: string | null; kind: string; filename: string; created_at: string }>(),
      canReadOwnedPerformance ? db.prepare(`
        SELECT w.id AS work_id, w.title AS work_title, s.as_of_at,
          s.views, s.completion_rate_bps, s.five_second_completion_rate_bps, s.cover_ctr_bps,
          s.two_second_bounce_rate_bps, s.avg_watch_ms, s.likes, s.shares, s.comments,
          s.saves, s.homepage_visits, s.follower_delta, batch.original_filename
        FROM platform_works w
        INNER JOIN platform_metric_snapshots s ON s.id = (
          SELECT latest.id FROM platform_metric_snapshots latest
          INNER JOIN platform_metric_import_batches latest_batch ON latest_batch.id = latest.import_batch_id AND latest_batch.status = 'completed'
          WHERE latest.organization_id = w.organization_id AND latest.project_id = w.project_id AND latest.work_id = w.id
          ORDER BY latest.as_of_at DESC LIMIT 1
        )
        INNER JOIN platform_metric_import_batches batch ON batch.id = s.import_batch_id AND batch.status = 'completed'
        WHERE w.organization_id = ? AND w.project_id = ? AND w.video_id = ? AND w.match_status = 'confirmed'
        LIMIT 1
      `).bind(organizationId, sourceProjectId, videoId).first<Record<string, unknown>>() : Promise.resolve(null),
    ]);
    const libraryQuery = `organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;
    const analysisVersions = analyses.results.map((analysis) => ({ ...analysis, report: parseStoredJson(analysis.report_json), report_json: undefined }));
    const selectedMedia = await readScopedAnalysisMedia(db, { organizationId, projectId: sourceProjectId, videoId }, typeof analysisVersions[0]?.id === "string" ? analysisVersions[0].id : null);
    const selected = analysisVersions[0];
    const assetUrl = (id: string) => sharedReference && libraryEntryId
      ? `/api/video-library/${libraryEntryId}/assets/${id}?${libraryQuery}` : `/api/videos/${videoId}/assets/${id}?${libraryQuery}`;
    const manuscript = manuscriptAssetForVersion(assets.results, selected ?? null, Boolean(requestedAnalysisId));
    const extractionMedia = !requestedAnalysisId && manuscript?.analysis_job_id && manuscript.analysis_job_id !== selected?.analysis_job_id
      ? await db.prepare("SELECT id,filename,content_type,size_bytes FROM media_assets WHERE organization_id=? AND project_id=? AND video_id=? AND analysis_job_id=? AND kind IN ('source_video','source_audio') AND status='active' ORDER BY created_at DESC,rowid DESC LIMIT 1")
        .bind(organizationId, sourceProjectId, videoId, manuscript.analysis_job_id).first<{ id: string; filename: string; content_type: string; size_bytes: number }>() : null;
    const media = extractionMedia ?? selectedMedia.media;
    const mediaQuery = selected?.id ? `${libraryQuery}&analysisId=${encodeURIComponent(selected.id)}` : libraryQuery;
    const mediaUrl = extractionMedia ? assetUrl(extractionMedia.id) : selectedMedia.media
      ? sharedReference && libraryEntryId ? `/api/video-library/${libraryEntryId}/media?${mediaQuery}` : `/api/videos/${videoId}/media?${mediaQuery}` : null;
    const historicalTranscript = requestedAnalysisId && selected ? await db.prepare("SELECT id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? AND created_at <= ? ORDER BY version DESC LIMIT 1")
      .bind(organizationId, sourceProjectId, videoId, selected.created_at).first<{ id: string; segments_json: string } & Record<string, unknown>>() : null;
    const transcript = requestedAnalysisId ? historicalTranscript : latestTranscript;
    const originalAsr = transcript?.source === "manual" ? await db.prepare("SELECT segments_json FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? AND source = 'asr' AND version < ? ORDER BY version DESC LIMIT 1")
      .bind(organizationId, sourceProjectId, videoId, transcript.version).first<{ segments_json: string }>() : null;
    const transcriptBinding = historicalTranscript && historicalTranscript.id !== latestTranscript?.id ? "historical" : "latest";
    const jobColumns = "id,status,analysis_profile,progress,current_stage,error_code,error_message,retry_count,checkpoint_stage,checkpoint_json,checkpoint_updated_at,resume_count,created_at,updated_at,completed_at";
    const selectedJobId = typeof selected?.analysis_job_id === "string" ? selected.analysis_job_id : null;
    const job = selected ? selectedJobId && selectedJobId === latestJob?.id ? latestJob : selectedJobId
      ? await db.prepare(`SELECT ${jobColumns} FROM analysis_jobs WHERE id=? AND organization_id=? AND project_id=? AND video_id=?`)
        .bind(selectedJobId, organizationId, sourceProjectId, videoId).first<Record<string, unknown>>() : null : latestJob;
    const newestForJob = job ? await db.prepare("SELECT id FROM video_analyses WHERE analysis_job_id=? AND organization_id=? AND project_id=? AND video_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .bind(job.id, organizationId, sourceProjectId, videoId).first<{ id: string }>() : null;
    const moduleRetry = job && selected && newestForJob?.id === selected.id
      ? readAnalysisModuleRetryState(typeof job.checkpoint_json === "string" ? job.checkpoint_json : null, selected.schema_version, selected.report, typeof job.status === "string" ? job.status : undefined) : null;
    const retryableModuleKeys = moduleRetry?.failedModuleKeys.filter(key => !moduleRetry.blockedModuleKeys.includes(key)) ?? [];
    const safeJob = job ? { ...job, checkpoint_json: undefined, segment_progress: summarizeSegmentProgress(job.checkpoint_json),
      module_retry: { available: !sharedReference && canWriteProjectAccess(access) && ["evidence_ready", "segment_progress"].includes(String(job.checkpoint_stage)) && (["partial", "failed"].includes(String(job.status)) || job.status === "completed" && moduleRetry?.canonicalNeedsReview === true) && Boolean(moduleRetry?.available) && retryableModuleKeys.length > 0, failedModuleKeys: retryableModuleKeys, reviewSegmentIds: moduleRetry?.reviewSegmentIds ?? [] } } : null;
    const safeLatestJob = latestJob ? { ...latestJob, checkpoint_json: undefined, segment_progress: summarizeSegmentProgress(latestJob.checkpoint_json) } : null;
    return Response.json({
      video: { ...video, filename: media?.filename ?? video.filename, content_type: media?.content_type ?? video.content_type,
        size_bytes: media?.size_bytes ?? video.size_bytes, media_binding: extractionMedia ? "manuscript" : selectedMedia.binding,
        is_shared_reference: sharedReference, library_entry_id: libraryEntryId, local_media_asset_id: undefined, media_url: mediaUrl },
      job: safeJob,
      latestJob: safeLatestJob,
      transcript_binding: transcriptBinding,
      original_asr_segments: parseStoredJson(originalAsr?.segments_json ?? null),
      transcript: transcript ? { ...transcript, segments: parseStoredJson(transcript.segments_json), segments_json: undefined } : null,
      analysis: analysisVersions[0] ?? null,
      analyses: analysisVersions,
      metrics: metrics.results,
      ownedPerformance,
      assets: assets.results.map((asset) => ({ ...asset, url: assetUrl(asset.id) })),
      events: events.results.map((event) => ({ ...event, details: parseStoredJson(typeof event.details_json === "string" ? event.details_json : null), details_json: undefined })),
      canWrite: !sharedReference && canWriteProjectAccess(access),
    });
  } catch (error) { return errorResponse(error); }
}
