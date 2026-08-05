import { canWriteProjectAccess, ensureUser, getD1, getMediaBucket, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const allowedTypes = new Set(["video/mp4", "video/quicktime", "video/webm", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"]);

function safeExtension(filename: string) { const match = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/); return match ? `.${match[1]}` : ""; }

export async function POST(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再上传媒体。", 401);
  let storedKey: string | null = null;
  try {
    const organizationId = request.headers.get("x-organization-id")?.trim() ?? ""; const projectId = request.headers.get("x-project-id")?.trim() ?? "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能上传分析素材。", 403);
    const form = await request.formData(); const file = form.get("file");
    if (!(file instanceof File)) return apiError("FILE_REQUIRED", "请选择视频或音频文件。", 400);
    if (!allowedTypes.has(file.type)) return apiError("UNSUPPORTED_MEDIA_TYPE", "仅支持 MP4、MOV、WebM、MP3、M4A 和 WAV。", 415);
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return apiError("INVALID_FILE_SIZE", "文件大小需要在 1 字节至 50 MB 之间。", 413);
    const user = await ensureUser(identity); const db = getD1(); const bytes = await file.arrayBuffer(); const sha256 = await sha256Hex(bytes);
    const duplicate = await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_hash = ? AND deleted_at IS NULL").bind(organizationId, projectId, sha256).first<{ id: string }>();
    if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", "相同媒体已经进入当前项目。", 409, { videoId: duplicate.id });
    const videoId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const now = new Date().toISOString();
    storedKey = `organizations/${organizationId}/projects/${projectId}/source/${videoId}${safeExtension(file.name)}`;
    await getMediaBucket().put(storedKey, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { organizationId, projectId, videoId, sha256 } });
    const kind = file.type.startsWith("audio/") ? "source_audio" : "source_video";
    await db.batch([
      db.prepare("INSERT INTO media_assets (id, organization_id, project_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").bind(assetId, organizationId, projectId, kind, storedKey, file.name, file.type, file.size, sha256, user.id, user.id, now, now),
      db.prepare("INSERT INTO videos (id, organization_id, project_id, media_asset_id, platform, source_type, source_hash, title, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'upload', 'upload', ?, ?, 'pending', ?, ?, ?, ?)").bind(videoId, organizationId, projectId, assetId, sha256, file.name, user.id, user.id, now, now),
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
