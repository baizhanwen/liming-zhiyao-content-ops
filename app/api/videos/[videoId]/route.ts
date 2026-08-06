import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

function parseStoredJson(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export async function GET(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request); if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问分析结果。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId); if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的分析结果。", 403);
    const { videoId } = await context.params; const db = getD1();
    let sourceProjectId = projectId; let libraryEntryId: string | null = null; let sharedReference = false;
    let video = await db.prepare(`
      SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
        a.filename, a.content_type, a.size_bytes
      FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active'
      WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
    `).bind(videoId, organizationId, projectId).first<Record<string, unknown>>();
    if (!video) {
      const reference = await db.prepare(`
        SELECT library.id AS library_entry_id, v.project_id AS source_project_id
        FROM project_video_references refs
        INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
        INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
        WHERE refs.organization_id = ? AND refs.project_id = ? AND v.id = ? AND v.deleted_at IS NULL
        LIMIT 1
      `).bind(organizationId, projectId, videoId).first<{ library_entry_id: string; source_project_id: string }>();
      if (!reference) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于当前项目。", 404);
      sourceProjectId = reference.source_project_id; libraryEntryId = reference.library_entry_id; sharedReference = true;
      video = await db.prepare(`
        SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
          a.filename, a.content_type, a.size_bytes
        FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active'
        WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
      `).bind(videoId, organizationId, sourceProjectId).first<Record<string, unknown>>();
    }
    if (!video) return apiError("VIDEO_NOT_FOUND", "视频素材源已不存在。", 404);
    if (!libraryEntryId) {
      libraryEntryId = (await db.prepare("SELECT id FROM video_library_entries WHERE organization_id = ? AND source_video_id = ? LIMIT 1").bind(organizationId, videoId).first<{ id: string }>())?.id ?? null;
    }
    const [job, transcript, analyses, metrics, events, assets] = await Promise.all([
      db.prepare("SELECT id, status, progress, current_stage, error_code, error_message, retry_count, created_at, updated_at, completed_at FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<Record<string, unknown>>(),
      db.prepare("SELECT id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY version DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<{ segments_json: string } & Record<string, unknown>>(),
      db.prepare("SELECT id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at FROM video_analyses WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 8").bind(organizationId, sourceProjectId, videoId).all<{ report_json: string } & Record<string, unknown>>(),
      db.prepare("SELECT source, plays, likes, comments, favorites, shares, followers_gained, collected_at FROM video_metric_snapshots WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY collected_at DESC LIMIT 10").bind(organizationId, sourceProjectId, videoId).all(),
      db.prepare("SELECT event_type, from_status, to_status, progress, details_json, created_at FROM analysis_job_events WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 50").bind(organizationId, sourceProjectId, videoId).all(),
      db.prepare("SELECT id, kind, filename, content_type, size_bytes, created_at FROM media_assets WHERE organization_id = ? AND project_id = ? AND video_id = ? AND kind IN ('keyframe', 'subtitle', 'report') AND status = 'active' ORDER BY created_at ASC").bind(organizationId, sourceProjectId, videoId).all(),
    ]);
    const libraryQuery = `organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}`;
    const analysisVersions = analyses.results.map((analysis) => ({ ...analysis, report: parseStoredJson(analysis.report_json), report_json: undefined }));
    return Response.json({
      video: { ...video, is_shared_reference: sharedReference, library_entry_id: libraryEntryId, media_url: video.source_type === "upload" ? (sharedReference && libraryEntryId ? `/api/video-library/${libraryEntryId}/media?${libraryQuery}` : `/api/videos/${videoId}/media?${libraryQuery}`) : null },
      job: job ?? null,
      transcript: transcript ? { ...transcript, segments: parseStoredJson(transcript.segments_json), segments_json: undefined } : null,
      analysis: analysisVersions[0] ?? null,
      analyses: analysisVersions,
      metrics: metrics.results,
      assets: assets.results.map((asset) => ({ ...asset, url: sharedReference && libraryEntryId ? `/api/video-library/${libraryEntryId}/assets/${asset.id}?${libraryQuery}` : `/api/videos/${videoId}/assets/${asset.id}?${libraryQuery}` })),
      events: events.results.map((event) => ({ ...event, details: parseStoredJson(typeof event.details_json === "string" ? event.details_json : null), details_json: undefined })),
      canWrite: !sharedReference && canWriteProjectAccess(access),
    });
  } catch (error) { return errorResponse(error); }
}
