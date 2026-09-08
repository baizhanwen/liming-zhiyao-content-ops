import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../db/runtime";
import { readAnalyzerReadiness } from "../../../lib/analyzer-readiness";
import { apiError, errorResponse } from "../../../lib/api-response";
import { summarizeSegmentProgress } from "../../../lib/analysis-segment-progress";
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
    const queueNow = new Date().toISOString();
    const [videos, jobs, readiness, queueStats, sharedQueue] = await Promise.all([
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
          WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'analysis' AND refs.status = 'active' AND v.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM videos own WHERE own.organization_id = refs.organization_id AND own.project_id = refs.project_id AND own.id = v.id AND own.deleted_at IS NULL)
        ) ORDER BY created_at DESC LIMIT 100
      `).bind(organizationId, projectId, organizationId, projectId).all(),
      db.prepare(`
        SELECT id, video_id, status, analysis_profile, progress, current_stage, error_code, error_message, retry_count, lease_expires_at, checkpoint_stage, checkpoint_json, checkpoint_updated_at, resume_count, created_at, updated_at
        FROM analysis_jobs
        WHERE organization_id = ? AND (project_id = ? OR video_id IN (
          SELECT library.source_video_id FROM project_video_references refs
          INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
          WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'analysis' AND refs.status = 'active'
        )) ORDER BY created_at DESC LIMIT 150
      `).bind(organizationId, projectId, organizationId, projectId).all(),
      readAnalyzerReadiness(organizationId),
      db.prepare(`
        SELECT COUNT(*) AS sample_count,
          CAST(AVG((julianday(completed_at) - julianday(started_at)) * 86400) AS INTEGER) AS average_seconds
        FROM (
          SELECT j.completed_at, (SELECT MIN(e.created_at) FROM analysis_job_events e WHERE e.job_id = j.id AND e.event_type = 'claimed') AS started_at
          FROM analysis_jobs j
          WHERE j.organization_id = ? AND j.project_id = ? AND j.status = 'completed' AND j.completed_at IS NOT NULL
            AND j.attempt_count = 1 AND j.retry_count = 0
          ORDER BY j.completed_at DESC LIMIT 20
        )
        WHERE started_at IS NOT NULL
      `).bind(organizationId, projectId).first<{ sample_count: number; average_seconds: number | null }>(),
      // The worker consumes one host-wide queue. Return aggregate counts only;
      // task details above still obey the caller's project access.
      db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN j.status = 'pending' OR j.lease_expires_at <= ? THEN 1 ELSE 0 END), 0) AS waiting_count,
          COALESCE(SUM(CASE WHEN j.status != 'pending' AND j.lease_expires_at > ? THEN 1 ELSE 0 END), 0) AS running_count
        FROM analysis_jobs j
        INNER JOIN videos v ON v.id = j.video_id AND v.organization_id = j.organization_id AND v.project_id = j.project_id AND v.deleted_at IS NULL
        WHERE j.status IN ('pending', 'queued', 'downloading', 'processing', 'transcribing', 'extracting', 'analyzing')
      `).bind(queueNow, queueNow).first<{ waiting_count: number; running_count: number }>(),
    ]);
    const safeJobs = jobs.results.map((job) => ({ ...job, checkpoint_json: undefined, segment_progress: summarizeSegmentProgress(job.checkpoint_json) }));
    return Response.json({
      videos: videos.results, jobs: safeJobs, canWrite: canWriteProjectAccess(access),
      queue: { sampleCount: queueStats?.sample_count ?? 0, averageSeconds: queueStats?.average_seconds ?? null, waitingCount: sharedQueue?.waiting_count ?? 0, runningCount: sharedQueue?.running_count ?? 0 },
      service: {
        credentialConfigured: readiness.credentialConfigured,
        modelConfigured: readiness.modelConfigured,
        publicLinkCookieConfigured: readiness.publicLinkCookieConfigured,
        publicLinkAuthenticationMode: readiness.publicLinkAuthenticationMode,
        browserLoginStatus: readiness.browserLoginStatus,
        browserLoginDetected: readiness.browserLoginDetected,
        browserLoginBrowser: readiness.browserLoginBrowser,
        browserLoginCheckedAt: readiness.browserLoginCheckedAt,
        browserLoginMessage: readiness.browserLoginMessage,
        cookieUpdatedAt: readiness.cookieUpdatedAt,
        analyzerOnline: readiness.analyzerOnline,
        lastWorkerHeartbeat: readiness.lastWorkerHeartbeat,
        checkedAt: readiness.checkedAt,
        canManageCookies: canWriteProjectAccess(access),
      },
    });
  } catch (error) { return errorResponse(error); }
}
