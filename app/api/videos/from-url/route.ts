import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../lib/operations";
import { extractDouyinUrl } from "../../../../lib/douyin-url";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再提交视频链接。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; url?: string; title?: string };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    const sourceUrl = extractDouyinUrl(payload.url ?? "");
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!sourceUrl) return apiError("INVALID_DOUYIN_URL", "请粘贴抖音分享文案或有效的抖音 HTTPS 链接。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建分析任务。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const sourceHash = await hashInvitationToken(`${organizationId}:${sourceUrl}`);
    const duplicate = await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND (source_url = ? OR source_hash = ?) AND deleted_at IS NULL").bind(organizationId, projectId, sourceUrl, sourceHash).first<{ id: string }>();
    if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", "该链接已经进入当前项目。", 409, { videoId: duplicate.id });
    const canonical = await db.prepare(`
      SELECT library.id AS library_entry_id, v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.created_at,
        job.id AS job_id, job.status AS job_status, job.progress, job.current_stage, job.error_code, job.error_message, job.retry_count, job.created_at AS job_created_at, job.updated_at AS job_updated_at
      FROM video_library_entries library
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      LEFT JOIN analysis_jobs job ON job.id = (SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1)
      WHERE library.organization_id = ? AND v.deleted_at IS NULL AND (v.source_url = ? OR v.source_hash = ?)
      LIMIT 1
    `).bind(organizationId, sourceUrl, sourceHash).first<Record<string, unknown>>();
    if (canonical) {
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, created_by, created_at) VALUES (?, ?, ?, ?, 'analysis', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, canonical.library_entry_id, user.id, now),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.analysis_reused', 'video_library_entry', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, canonical.library_entry_id, JSON.stringify({ sourceUrl, sourceVideoId: canonical.id }), now),
      ]);
      return Response.json({
        reused: true,
        video: { id: canonical.id, platform: canonical.platform, source_type: canonical.source_type, source_url: canonical.source_url, title: canonical.title, author_name: canonical.author_name, status: canonical.status, created_at: canonical.created_at, is_reference: true, library_entry_id: canonical.library_entry_id },
        job: canonical.job_id ? { id: canonical.job_id, video_id: canonical.id, status: canonical.job_status, progress: canonical.progress, current_stage: canonical.current_stage, error_code: canonical.error_code, error_message: canonical.error_message, retry_count: canonical.retry_count, created_at: canonical.job_created_at, updated_at: canonical.job_updated_at } : { id: `reused-${canonical.id}`, video_id: canonical.id, status: canonical.status === "ready" ? "completed" : "pending", progress: canonical.status === "ready" ? 100 : 0, current_stage: "复用公司素材库分析", retry_count: 0, created_at: canonical.created_at, updated_at: canonical.created_at },
      });
    }
    const quota = await checkOrganizationQuota(organizationId, user.id, "analyses");
    if (!quota.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务已达到 ${quota.limit} 次套餐上限。`, 429, { usage: quota.current, limit: quota.limit });
    const videoId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO videos (id, organization_id, project_id, platform, source_type, source_url, source_hash, title, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'douyin', 'url', ?, ?, ?, 'pending', ?, ?, ?, ?)").bind(videoId, organizationId, projectId, sourceUrl, sourceHash, payload.title?.trim() || null, user.id, user.id, now, now),
      db.prepare("INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'other', '[]', ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, videoId, user.id, user.id, now, now),
      db.prepare("INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, source_type, source_ref, idempotency_key, status, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'url', ?, ?, 'pending', 0, '等待进入分析队列', 0, ?, ?, ?, ?)").bind(jobId, organizationId, projectId, videoId, sourceUrl, sourceHash, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.url_submitted', 'video', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, videoId, JSON.stringify({ sourceUrl }), now),
    ]);
    return Response.json({ video: { id: videoId, platform: "douyin", source_type: "url", source_url: sourceUrl, title: payload.title?.trim() || null, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", progress: 0, current_stage: "等待进入分析队列", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
