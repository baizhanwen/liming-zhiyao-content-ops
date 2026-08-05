import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
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
    const [videos, jobs] = await Promise.all([
      db.prepare(`SELECT v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.error_message, v.created_at, a.filename, a.size_bytes FROM videos v LEFT JOIN media_assets a ON a.id = v.media_asset_id WHERE v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL ORDER BY v.created_at DESC LIMIT 100`).bind(organizationId, projectId).all(),
      db.prepare(`SELECT id, video_id, status, progress, current_stage, error_code, error_message, retry_count, created_at, updated_at FROM analysis_jobs WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(organizationId, projectId).all(),
    ]);
    return Response.json({ videos: videos.results, jobs: jobs.results, canWrite: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}
