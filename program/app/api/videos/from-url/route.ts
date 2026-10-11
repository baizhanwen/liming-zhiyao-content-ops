import { resolveVideoSubmission, newVideoSubmissionStatements } from "../../../../lib/video-submission";
import { checkNewAnalysisAvailability } from "../../../../lib/analysis-submission-availability";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { extractDouyinUrl } from "../../../../lib/douyin-url";
import { normalizeAnalysisProfile } from "../../../../lib/analysis-profile";
import { isAnalysisSubmissionConflict } from "../../../../lib/analysis-submission-errors";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError } from "../../../../lib/project-write-access";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再提交视频链接。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; url?: string; title?: string; analysisProfile?: unknown };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    const analysisProfile = normalizeAnalysisProfile(payload.analysisProfile);
    const sourceUrl = extractDouyinUrl(payload.url ?? "");
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!sourceUrl) return apiError("INVALID_DOUYIN_URL", "请粘贴抖音分享文案或有效的抖音 HTTPS 链接。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建分析任务。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const sourceHash = await hashInvitationToken(`${organizationId}:${sourceUrl}`);
    const submission = { organizationId, projectId, userId: user.id, now, sourceType: "url" as const, sourceHash, sourceUrl };
    const assertAccess = createProjectWriteAssertion(db, submission, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    await assertAccess();
    const existingOrError = await resolveVideoSubmission(db, submission, () => checkNewAnalysisAvailability({ organizationId, userId: user.id, requiresBrowser: true }), assertAccess);
    if (existingOrError) return existingOrError;
    const videoId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    await assertAccess();
    const results = await db.batch(newVideoSubmissionStatements(db, { ...submission, videoId, jobId, title: payload.title?.trim() || null, analysisProfile, auditMetadata: { sourceUrl, analysisProfile } }));
    if (!results[0].meta.changes) throw new ProjectWriteAccessChangedError();
    return Response.json({ video: { id: videoId, platform: "douyin", source_type: "url", source_url: sourceUrl, title: payload.title?.trim() || null, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", analysis_profile: analysisProfile, progress: 0, current_stage: "等待进入分析队列", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) {
    if (error instanceof ProjectWriteAccessChangedError) return apiError(error.code, "登录状态或项目权限已改变，本次资料未保存。请刷新确认权限后重新提交。", 403);
    if (isAnalysisSubmissionConflict(error)) return apiError("VIDEO_SUBMISSION_CONFLICT", "相同素材已被其他成员提交。本次没有新建分析任务，请刷新列表；若素材在其他项目，再次提交即可复用。", 409);
    return errorResponse(error);
  }
}
