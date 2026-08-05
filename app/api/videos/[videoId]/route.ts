import { getD1, getProjectAccess } from "../../../../db/runtime";
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
    const video = await db.prepare(`
      SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
        a.filename, a.content_type, a.size_bytes
      FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active'
      WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
    `).bind(videoId, organizationId, projectId).first<Record<string, unknown>>();
    if (!video) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于当前项目。", 404);
    const [job, transcript, analysis, metrics, events, assets] = await Promise.all([
      db.prepare("SELECT id, status, progress, current_stage, error_code, error_message, retry_count, created_at, updated_at, completed_at FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1").bind(organizationId, projectId, videoId).first<Record<string, unknown>>(),
      db.prepare("SELECT id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY version DESC LIMIT 1").bind(organizationId, projectId, videoId).first<{ segments_json: string } & Record<string, unknown>>(),
      db.prepare("SELECT id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at FROM video_analyses WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1").bind(organizationId, projectId, videoId).first<{ report_json: string } & Record<string, unknown>>(),
      db.prepare("SELECT source, plays, likes, comments, favorites, shares, followers_gained, collected_at FROM video_metric_snapshots WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY collected_at DESC LIMIT 10").bind(organizationId, projectId, videoId).all(),
      db.prepare("SELECT event_type, from_status, to_status, progress, details_json, created_at FROM analysis_job_events WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 50").bind(organizationId, projectId, videoId).all(),
      db.prepare("SELECT id, kind, filename, content_type, size_bytes, created_at FROM media_assets WHERE organization_id = ? AND project_id = ? AND video_id = ? AND kind IN ('keyframe', 'subtitle', 'report') AND status = 'active' ORDER BY created_at ASC").bind(organizationId, projectId, videoId).all(),
    ]);
    return Response.json({
      video: { ...video, media_url: video.source_type === "upload" ? `/api/videos/${videoId}/media?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}` : null },
      job: job ?? null,
      transcript: transcript ? { ...transcript, segments: parseStoredJson(transcript.segments_json), segments_json: undefined } : null,
      analysis: analysis ? { ...analysis, report: parseStoredJson(analysis.report_json), report_json: undefined } : null,
      metrics: metrics.results,
      assets: assets.results.map((asset) => ({ ...asset, url: `/api/videos/${videoId}/assets/${asset.id}?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}` })),
      events: events.results.map((event) => ({ ...event, details: parseStoredJson(typeof event.details_json === "string" ? event.details_json : null), details_json: undefined })),
    });
  } catch (error) { return errorResponse(error); }
}
