import { env } from "cloudflare:workers";
import { canWriteProjectAccess, getD1, getMediaBucket, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { douyinCookieObjectKey } from "../../../lib/douyin-cookie-snapshot";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问视频数据。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的视频。", 403);
    const db = getD1();
    const [videos, jobs, lastWorkerHeartbeat, cookieSnapshot] = await Promise.all([
      db.prepare(`
        SELECT * FROM (
          SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.error_message, v.created_at, a.filename, a.size_bytes,
            0 AS is_reference, (SELECT library.id FROM video_library_entries library WHERE library.organization_id = v.organization_id AND library.source_video_id = v.id LIMIT 1) AS library_entry_id
          FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id
          WHERE v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
          UNION ALL
          SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.error_message, refs.created_at, a.filename, a.size_bytes,
            1 AS is_reference, library.id AS library_entry_id
          FROM project_video_references refs
          INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
          INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
          LEFT JOIN media_assets a ON a.id = v.media_asset_id
          WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'analysis' AND v.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM videos own WHERE own.organization_id = refs.organization_id AND own.project_id = refs.project_id AND own.id = v.id AND own.deleted_at IS NULL)
        ) ORDER BY created_at DESC LIMIT 100
      `).bind(organizationId, projectId, organizationId, projectId).all(),
      db.prepare(`
        SELECT id, video_id, status, progress, current_stage, error_code, error_message, retry_count, created_at, updated_at
        FROM analysis_jobs
        WHERE organization_id = ? AND (project_id = ? OR video_id IN (
          SELECT library.source_video_id FROM project_video_references refs
          INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
          WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'analysis'
        )) ORDER BY created_at DESC LIMIT 150
      `).bind(organizationId, projectId, organizationId, projectId).all(),
      db.prepare("SELECT MAX(last_seen_at) AS value FROM analyzer_workers WHERE status = 'online'").first<{ value: string | null }>(),
      getMediaBucket().head(douyinCookieObjectKey(organizationId)),
    ]);
    const runtime = env as typeof env & { ANALYZER_SERVICE_TOKEN?: string; ANALYZER_LLM_API_KEY?: string; ANALYZER_LLM_BASE_URL?: string; ANALYZER_LLM_MODEL?: string; ANALYZER_LLM_PROVIDER?: string; ANALYZER_YTDLP_COOKIES_FROM_BROWSER?: string; ANALYZER_YTDLP_COOKIE_FILE?: string };
    const token = runtime.ANALYZER_SERVICE_TOKEN?.trim() ?? "";
    const workerLastSeen = lastWorkerHeartbeat?.value ?? null;
    return Response.json({
      videos: videos.results, jobs: jobs.results, canWrite: canWriteProjectAccess(access),
      service: {
        credentialConfigured: Boolean(token && !/change-me|replace-with/i.test(token)),
        modelConfigured: Boolean(runtime.ANALYZER_LLM_API_KEY?.trim() && runtime.ANALYZER_LLM_BASE_URL?.trim() && runtime.ANALYZER_LLM_MODEL?.trim() && runtime.ANALYZER_LLM_PROVIDER?.trim()),
        publicLinkCookieConfigured: Boolean(cookieSnapshot || runtime.ANALYZER_YTDLP_COOKIE_FILE?.trim() || runtime.ANALYZER_YTDLP_COOKIES_FROM_BROWSER?.trim()),
        cookieUpdatedAt: cookieSnapshot?.customMetadata?.updatedAt ?? null,
        canManageCookies: access.organizationRole === "admin",
        analyzerOnline: Boolean(workerLastSeen && new Date(workerLastSeen).getTime() >= Date.now() - 20_000),
        lastWorkerHeartbeat: workerLastSeen,
      },
    });
  } catch (error) { return errorResponse(error); }
}
