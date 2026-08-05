import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../../lib/operations";

function normalizeDouyinUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const allowed = host === "douyin.com" || host.endsWith(".douyin.com") || host === "iesdouyin.com" || host.endsWith(".iesdouyin.com");
    if (url.protocol !== "https:" || !allowed) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再提交视频链接。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; url?: string; title?: string };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    const sourceUrl = normalizeDouyinUrl(payload.url ?? "");
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!sourceUrl) return apiError("INVALID_DOUYIN_URL", "请输入有效的抖音 HTTPS 链接。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建分析任务。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const quota = await checkOrganizationQuota(organizationId, user.id, "analyses");
    if (!quota.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务已达到 ${quota.limit} 次套餐上限。`, 429, { usage: quota.current, limit: quota.limit });
    const sourceHash = await hashInvitationToken(`${organizationId}:${projectId}:${sourceUrl}`);
    const duplicate = await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_hash = ? AND deleted_at IS NULL").bind(organizationId, projectId, sourceHash).first<{ id: string }>();
    if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", "该链接已经进入当前项目。", 409, { videoId: duplicate.id });
    const videoId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO videos (id, organization_id, project_id, platform, source_type, source_url, source_hash, title, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'douyin', 'url', ?, ?, ?, 'pending', ?, ?, ?, ?)").bind(videoId, organizationId, projectId, sourceUrl, sourceHash, payload.title?.trim() || null, user.id, user.id, now, now),
      db.prepare("INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, source_type, source_ref, idempotency_key, status, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'url', ?, ?, 'pending', 0, '等待进入分析队列', 0, ?, ?, ?, ?)").bind(jobId, organizationId, projectId, videoId, sourceUrl, sourceHash, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.url_submitted', 'video', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, videoId, JSON.stringify({ sourceUrl }), now),
    ]);
    return Response.json({ video: { id: videoId, platform: "douyin", source_type: "url", source_url: sourceUrl, title: payload.title?.trim() || null, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", progress: 0, current_stage: "等待进入分析队列", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) { return errorResponse(error); }
}
