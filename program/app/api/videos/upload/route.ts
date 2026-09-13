import { resolveVideoSubmission, newVideoSubmissionStatements } from "../../../../lib/video-submission";
import { checkNewAnalysisAvailability } from "../../../../lib/analysis-submission-availability";
import { canWriteProjectAccess, ensureUser, getD1, getMediaBucket, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { normalizeAnalysisProfile } from "../../../../lib/analysis-profile";
import { isAnalysisSubmissionConflict } from "../../../../lib/analysis-submission-errors";

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
    const form = await request.formData(); const file = form.get("file"); const analysisProfile = normalizeAnalysisProfile(form.get("analysisProfile"));
    if (!(file instanceof File)) return apiError("FILE_REQUIRED", "请选择视频或音频文件。", 400);
    if (!allowedTypes.has(file.type)) return apiError("UNSUPPORTED_MEDIA_TYPE", "仅支持 MP4、MOV、WebM、MP3、M4A 和 WAV。", 415);
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return apiError("INVALID_FILE_SIZE", "文件大小需要在 1 字节至 50 MB 之间。", 413);
    const user = await ensureUser(identity); const db = getD1(); const bytes = await file.arrayBuffer(); const sha256 = await sha256Hex(bytes); const now = new Date().toISOString();
    const submission = { organizationId, projectId, userId: user.id, now, sourceType: "upload" as const, sourceHash: sha256, filename: file.name };
    const existingOrError = await resolveVideoSubmission(db, submission, () => checkNewAnalysisAvailability({ organizationId, userId: user.id, requiresBrowser: false, uploadBytes: file.size }));
    if (existingOrError) return existingOrError;
    const videoId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    storedKey = `organizations/${organizationId}/projects/${projectId}/source/${videoId}${safeExtension(file.name)}`;
    await getMediaBucket().put(storedKey, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { organizationId, projectId, videoId, sha256 } });
    const kind = file.type.startsWith("audio/") ? "source_audio" : "source_video";
    await db.batch([
      db.prepare("INSERT INTO media_assets (id, organization_id, project_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").bind(assetId, organizationId, projectId, kind, storedKey, file.name, file.type, file.size, sha256, user.id, user.id, now, now),
      ...newVideoSubmissionStatements(db, { ...submission, videoId, jobId, mediaAssetId: assetId, title: file.name, analysisProfile, auditMetadata: { assetId, filename: file.name, size: file.size, analysisProfile } }),
      db.prepare("UPDATE media_assets SET video_id = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND video_id IS NULL").bind(videoId, now, assetId, organizationId, projectId),
    ]);
    storedKey = null;
    return Response.json({ video: { id: videoId, platform: "upload", source_type: "upload", title: file.name, filename: file.name, size_bytes: file.size, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", analysis_profile: analysisProfile, progress: 0, current_stage: "媒体已入库，等待分析", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) {
    if (storedKey) { try { await getMediaBucket().delete(storedKey); } catch { /* best-effort rollback */ } }
    if (isAnalysisSubmissionConflict(error)) return apiError("VIDEO_SUBMISSION_CONFLICT", "相同素材已被其他成员提交。本次没有新建分析任务，请刷新列表；若素材在其他项目，再次提交即可复用。", 409);
    return errorResponse(error);
  }
}
