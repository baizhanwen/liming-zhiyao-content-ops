import { canAccessOrganizationVideoLibrary, getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

function parseJson(value: unknown) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function GET(request: Request, context: { params: Promise<{ entryId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问公司素材分析。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || !await canAccessOrganizationVideoLibrary(access)) return apiError("ACCESS_DENIED", "当前角色不能查看公司素材分析。", 403);
    const { entryId } = await context.params;
    const db = getD1();
    const video = await db.prepare(`
      SELECT library.id AS library_entry_id, library.category, library.tags_json, library.notes, library.created_at AS library_created_at, library.updated_at AS library_updated_at,
        v.id, v.organization_id, v.project_id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status, v.error_message, v.created_at,
        p.name AS source_project_name, a.display_name AS account_name, asset.filename, asset.content_type, asset.size_bytes
      FROM video_library_entries library
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
      INNER JOIN projects p ON p.id = v.project_id AND p.organization_id = v.organization_id
      LEFT JOIN social_accounts a ON a.id = v.social_account_id
      LEFT JOIN media_assets asset ON asset.id = v.media_asset_id AND asset.organization_id = v.organization_id AND asset.project_id = v.project_id AND asset.status = 'active'
      WHERE library.id = ? AND library.organization_id = ?
    `).bind(entryId, organizationId).first<Record<string, unknown>>();
    if (!video) return apiError("LIBRARY_ENTRY_NOT_FOUND", "公司素材不存在。", 404);
    const sourceProjectId = String(video.project_id); const videoId = String(video.id);
    const [job, transcript, analyses, metrics, events, assets] = await Promise.all([
      db.prepare("SELECT id, status, progress, current_stage, error_code, error_message, retry_count, created_at, updated_at, completed_at FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<Record<string, unknown>>(),
      db.prepare("SELECT id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY version DESC LIMIT 1").bind(organizationId, sourceProjectId, videoId).first<Record<string, unknown>>(),
      db.prepare("SELECT id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at FROM video_analyses WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 8").bind(organizationId, sourceProjectId, videoId).all<Record<string, unknown>>(),
      db.prepare("SELECT source, plays, likes, comments, favorites, shares, followers_gained, collected_at FROM video_metric_snapshots WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY collected_at DESC LIMIT 10").bind(organizationId, sourceProjectId, videoId).all(),
      db.prepare("SELECT event_type, from_status, to_status, progress, details_json, created_at FROM analysis_job_events WHERE organization_id = ? AND project_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 50").bind(organizationId, sourceProjectId, videoId).all<Record<string, unknown>>(),
      db.prepare("SELECT id, kind, filename, content_type, size_bytes, is_cover, quality_score, created_at FROM media_assets WHERE organization_id = ? AND project_id = ? AND video_id = ? AND kind IN ('keyframe', 'subtitle', 'report') AND status = 'active' ORDER BY kind, is_cover DESC, COALESCE(quality_score, 0) DESC, created_at ASC").bind(organizationId, sourceProjectId, videoId).all<Record<string, unknown>>(),
    ]);
    return Response.json({
      entry: { ...video, tags: parseJson(video.tags_json) ?? [], tags_json: undefined },
      job: job ?? null,
      transcript: transcript ? { ...transcript, segments: parseJson(transcript.segments_json), segments_json: undefined } : null,
      analysis: analyses.results[0] ? { ...analyses.results[0], report: parseJson(analyses.results[0].report_json), report_json: undefined } : null,
      analyses: analyses.results.map((analysis) => ({ ...analysis, report: parseJson(analysis.report_json), report_json: undefined })),
      metrics: metrics.results,
      assets: assets.results.map((asset) => ({ ...asset, url: `/api/video-library/${encodeURIComponent(entryId)}/assets/${encodeURIComponent(String(asset.id))}?organizationId=${encodeURIComponent(organizationId)}` })),
      events: events.results.map((event) => ({ ...event, details: parseJson(event.details_json), details_json: undefined })),
    });
  } catch (error) { return errorResponse(error); }
}
