import { canWriteProjectAccess, ensureUser, getD1, getMediaBucket, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { analyzerReadinessError, readAnalyzerReadiness } from "../../../../lib/analyzer-readiness";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../lib/operations";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const allowedTypes = new Set(["video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"]);

function safeExtension(filename: string) { const match = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/); return match ? `.${match[1]}` : ""; }

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再上传媒体。", 401);
  let storedKey: string | null = null;
  try {
    const organizationId = request.headers.get("x-organization-id")?.trim() ?? ""; const projectId = request.headers.get("x-project-id")?.trim() ?? "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能上传分析素材。", 403);
    const readinessIssue = analyzerReadinessError(await readAnalyzerReadiness(organizationId), false);
    if (readinessIssue) return apiError(readinessIssue.code, readinessIssue.message, 503);
    const form = await request.formData(); const file = form.get("file");
    if (!(file instanceof File)) return apiError("FILE_REQUIRED", "请选择视频或音频文件。", 400);
    if (!allowedTypes.has(file.type)) return apiError("UNSUPPORTED_MEDIA_TYPE", "仅支持 MP4、MOV、WebM、MP3、M4A 和 WAV。", 415);
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return apiError("INVALID_FILE_SIZE", "文件大小需要在 1 字节至 50 MB 之间。", 413);
    const user = await ensureUser(identity); const db = getD1(); const bytes = await file.arrayBuffer(); const sha256 = await sha256Hex(bytes); const now = new Date().toISOString();
    const duplicate = await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_hash = ? AND deleted_at IS NULL").bind(organizationId, projectId, sha256).first<{ id: string }>();
    if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", "相同媒体已经进入当前项目。", 409, { videoId: duplicate.id });
    const canonical = await db.prepare(`
      SELECT library.id AS library_entry_id, v.id, v.platform, v.source_type, v.title, v.author_name, v.status, v.created_at, a.filename, a.size_bytes,
        job.id AS job_id, job.status AS job_status, job.progress, job.current_stage, job.error_code, job.error_message, job.retry_count, job.created_at AS job_created_at, job.updated_at AS job_updated_at
      FROM video_library_entries library
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      LEFT JOIN media_assets a ON a.id = v.media_asset_id
      LEFT JOIN analysis_jobs job ON job.id = (SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1)
      WHERE library.organization_id = ? AND v.source_hash = ? AND v.deleted_at IS NULL
      LIMIT 1
    `).bind(organizationId, sha256).first<Record<string, unknown>>();
    if (canonical) {
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, created_by, created_at) VALUES (?, ?, ?, ?, 'analysis', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, canonical.library_entry_id, user.id, now),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.analysis_reused', 'video_library_entry', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, canonical.library_entry_id, JSON.stringify({ filename: file.name, sourceVideoId: canonical.id }), now),
      ]);
      return Response.json({
        reused: true,
        video: { id: canonical.id, platform: canonical.platform, source_type: canonical.source_type, title: canonical.title, author_name: canonical.author_name, filename: canonical.filename, size_bytes: canonical.size_bytes, status: canonical.status, created_at: canonical.created_at, is_reference: true, library_entry_id: canonical.library_entry_id },
        job: canonical.job_id ? { id: canonical.job_id, video_id: canonical.id, status: canonical.job_status, progress: canonical.progress, current_stage: canonical.current_stage, error_code: canonical.error_code, error_message: canonical.error_message, retry_count: canonical.retry_count, created_at: canonical.job_created_at, updated_at: canonical.job_updated_at } : { id: `reused-${canonical.id}`, video_id: canonical.id, status: canonical.status === "ready" ? "completed" : "pending", progress: canonical.status === "ready" ? 100 : 0, current_stage: "复用公司素材库分析", retry_count: 0, created_at: canonical.created_at, updated_at: canonical.created_at },
      });
    }
    const [analysisQuota, storageQuota] = await Promise.all([
      checkOrganizationQuota(organizationId, user.id, "analyses"),
      checkOrganizationQuota(organizationId, user.id, "storageBytes", file.size),
    ]);
    if (!analysisQuota.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务已达到 ${analysisQuota.limit} 次套餐上限。`, 429, { usage: analysisQuota.current, limit: analysisQuota.limit });
    if (!storageQuota.allowed) return apiError("STORAGE_QUOTA_EXCEEDED", "本次上传会超过公司的媒体存储配额。", 429, { usage: storageQuota.current, limit: storageQuota.limit });
    const videoId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    storedKey = `organizations/${organizationId}/projects/${projectId}/source/${videoId}${safeExtension(file.name)}`;
    await getMediaBucket().put(storedKey, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { organizationId, projectId, videoId, sha256 } });
    const kind = file.type.startsWith("audio/") ? "source_audio" : "source_video";
    await db.batch([
      db.prepare("INSERT INTO media_assets (id, organization_id, project_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").bind(assetId, organizationId, projectId, kind, storedKey, file.name, file.type, file.size, sha256, user.id, user.id, now, now),
      db.prepare("INSERT INTO videos (id, organization_id, project_id, media_asset_id, platform, source_type, source_hash, title, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'upload', 'upload', ?, ?, 'pending', ?, ?, ?, ?)").bind(videoId, organizationId, projectId, assetId, sha256, file.name, user.id, user.id, now, now),
      db.prepare("INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'other', '[]', ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, videoId, user.id, user.id, now, now),
      db.prepare("UPDATE media_assets SET video_id = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND video_id IS NULL").bind(videoId, now, assetId, organizationId, projectId),
      db.prepare("INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, source_type, source_ref, idempotency_key, status, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'upload', ?, ?, 'pending', 0, '媒体已入库，等待分析', 0, ?, ?, ?, ?)").bind(jobId, organizationId, projectId, videoId, assetId, sha256, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.uploaded', 'video', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, videoId, JSON.stringify({ assetId, filename: file.name, size: file.size }), now),
    ]);
    storedKey = null;
    return Response.json({ video: { id: videoId, platform: "upload", source_type: "upload", title: file.name, filename: file.name, size_bytes: file.size, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", progress: 0, current_stage: "媒体已入库，等待分析", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) {
    if (storedKey) { try { await getMediaBucket().delete(storedKey); } catch { /* best-effort rollback */ } }
    return errorResponse(error);
  }
}
