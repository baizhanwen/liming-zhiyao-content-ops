import { activeAnalysisStatuses as activeStatuses } from "../../../../../lib/analysis-jobs";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { analyzerReadinessError, readAnalyzerReadiness } from "../../../../../lib/analyzer-readiness";
import { normalizeAnalysisProfile } from "../../../../../lib/analysis-profile";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { checkOrganizationQuota } from "../../../../../lib/operations";
import { readRequestIdentity } from "../../../../../lib/request-auth";

type VideoRow = { id: string; source_type: "url" | "upload"; source_url: string | null; media_asset_id: string | null };

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再重新分析。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; analysisProfile?: unknown };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const { videoId } = await context.params; const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能重新分析视频。", 403);
    const db = getD1(); const video = await db.prepare("SELECT id, source_type, source_url, media_asset_id FROM videos WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(videoId, organizationId, projectId).first<VideoRow>();
    if (!video) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于当前项目。", 404);
    const active = await db.prepare(`SELECT id FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")}) LIMIT 1`).bind(organizationId, projectId, videoId, ...activeStatuses).first();
    if (active) return apiError("ANALYSIS_ALREADY_RUNNING", "当前视频已有分析任务正在运行。", 409);
    const readinessIssue = analyzerReadinessError(await readAnalyzerReadiness(organizationId), video.source_type === "url");
    if (readinessIssue) return apiError(readinessIssue.code, readinessIssue.message, 503);
    const user = await ensureUser(identity); const quota = await checkOrganizationQuota(organizationId, user.id, "analyses");
    if (!quota.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务已达到 ${quota.limit} 次套餐上限。`, 429, { usage: quota.current, limit: quota.limit });
    const sourceRef = video.source_type === "upload" ? video.media_asset_id : video.source_url;
    if (!sourceRef) return apiError("SOURCE_UNAVAILABLE", "原始媒体来源不存在，无法重新分析。", 409);
    const transcript = await db.prepare("SELECT id FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ? AND source = 'manual' ORDER BY version DESC LIMIT 1").bind(organizationId, projectId, videoId).first<{ id: string }>();
    const analysisProfile = normalizeAnalysisProfile(payload.analysisProfile); const now = new Date().toISOString(); const jobId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(`INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, input_transcript_id, source_type, source_ref, idempotency_key, status, analysis_profile, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, '等待按新模式重新分析', 0, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")}))
      `).bind(jobId, organizationId, projectId, videoId, transcript?.id ?? null, video.source_type, sourceRef, `reanalyze:${jobId}`, analysisProfile, user.id, user.id, now, now, organizationId, projectId, videoId, ...activeStatuses),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'analysis_job.reanalysis_created', 'analysis_job', ?, ?, ? WHERE EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, jobId, JSON.stringify({ videoId, analysisProfile, inputTranscriptId: transcript?.id ?? null }), now, jobId),
    ]);
    if (!results[0].meta.changes) return apiError("ANALYSIS_ALREADY_RUNNING", "其他成员已启动该视频的分析，请刷新查看进度。", 409);
    return Response.json({ job: { id: jobId, video_id: videoId, status: "pending", analysis_profile: analysisProfile, progress: 0, current_stage: "等待按新模式重新分析", retry_count: 0, created_at: now, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
