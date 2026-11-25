import { waitUntil } from "cloudflare:workers";
import { collectVideoMetadata } from "../../../../lib/video-metadata-runtime";
import { isAnalysisCollectionMode, normalizeAnalysisCollectionMode } from "../../../../lib/analysis-collection-mode";
import { isAnalysisExecutionMode, normalizeNewAnalysisExecutionMode } from "../../../../lib/analysis-execution-mode";
import { resolveVideoSubmission, newVideoSubmissionStatements } from "../../../../lib/video-submission";
import { checkNewAnalysisAvailability } from "../../../../lib/analysis-submission-availability";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, hashInvitationToken } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { extractDouyinUrl } from "../../../../lib/douyin-url";
import { isVisualSamplingLevel, normalizeVisualSamplingLevel } from "../../../../lib/visual-sampling-level";
import { isVisualAnalysisMode, normalizeNewVisualAnalysisMode } from "../../../../lib/visual-analysis-mode";
import { normalizeAnalysisProfile } from "../../../../lib/analysis-profile";
import { isAnalysisSubmissionConflict } from "../../../../lib/analysis-submission-errors";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError } from "../../../../lib/project-write-access";
import { readBoundedJson, RequestBodyError } from "../../../../lib/bounded-request-body";

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再提交视频链接。", 401);
  try {
    const input = await readBoundedJson(request, 32 * 1024, "链接提交内容过大，请缩短分享文案或内部备注后重新提交。");
    if (!input || typeof input !== "object" || Array.isArray(input) || ["organizationId", "projectId", "url", "title"].some(key => {
      const value = (input as Record<string, unknown>)[key]; return value !== undefined && value !== null && typeof value !== "string";
    })) return apiError("INVALID_VIDEO_INPUT", "链接提交格式无效，请检查公司、项目、链接和内部备注。", 400);
    const payload = input as { organizationId?: string; projectId?: string; url?: string; title?: string; analysisProfile?: unknown; transcriptReviewEnabled?: unknown; visualAnalysisMode?: unknown; visualSamplingLevel?: unknown; executionMode?: unknown; collectionMode?: unknown };
    if (payload.transcriptReviewEnabled !== undefined && typeof payload.transcriptReviewEnabled !== "boolean") return apiError("INVALID_TRANSCRIPT_REVIEW_OPTION", "口播稿 AI 核对选项必须为布尔值。", 400);
    if (payload.visualAnalysisMode !== undefined && !isVisualAnalysisMode(payload.visualAnalysisMode)) return apiError("INVALID_VISUAL_ANALYSIS_MODE", "请选择有效的画面分析模式。", 400);
    if (payload.visualSamplingLevel !== undefined && !isVisualSamplingLevel(payload.visualSamplingLevel)) return apiError("INVALID_VISUAL_SAMPLING_LEVEL", "请选择有效的画面采样档位。", 400);
    if (payload.executionMode !== undefined && !isAnalysisExecutionMode(payload.executionMode)) return apiError("INVALID_ANALYSIS_EXECUTION_MODE", "请选择有效的执行方式。", 400);
    if (payload.collectionMode !== undefined && !isAnalysisCollectionMode(payload.collectionMode)) return apiError("INVALID_ANALYSIS_COLLECTION_MODE", "请选择有效的采集方式。", 400);
    const collectionMode = normalizeAnalysisCollectionMode(payload.collectionMode);
    const executionMode = normalizeNewAnalysisExecutionMode(payload.executionMode);
    const visualSamplingLevel = normalizeVisualSamplingLevel(payload.visualSamplingLevel);
    const visualAnalysisMode = normalizeNewVisualAnalysisMode(payload.visualAnalysisMode);
    const transcriptReviewEnabled = payload.transcriptReviewEnabled !== false;
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    const analysisProfile = normalizeAnalysisProfile(payload.analysisProfile);
    const sourceUrl = extractDouyinUrl(payload.url ?? "");
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!sourceUrl) return apiError("INVALID_DOUYIN_URL", "请粘贴抖音分享文案或有效的抖音 HTTPS 链接。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建分析任务。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const sourceHash = await hashInvitationToken(`${organizationId}:${sourceUrl}`);
    const submission = { organizationId, projectId, userId: user.id, now, sourceType: "url" as const, sourceHash, sourceUrl, transcriptReviewEnabled, visualAnalysisMode, visualSamplingLevel, executionMode, collectionMode };
    const assertAccess = createProjectWriteAssertion(db, submission, async () => (await readRequestIdentity(request))?.authSubject === identity.authSubject);
    await assertAccess();
    const existingOrError = await resolveVideoSubmission(db, submission, () => checkNewAnalysisAvailability({ organizationId, userId: user.id, requiresBrowser: true, collectionMode, visualAnalysisMode }), assertAccess);
    if (existingOrError) return existingOrError;
    const videoId = crypto.randomUUID(); const jobId = crypto.randomUUID();
    await assertAccess();
    const results = await db.batch(newVideoSubmissionStatements(db, { ...submission, videoId, jobId, title: payload.title?.trim() || null, analysisProfile, auditMetadata: { sourceUrl, analysisProfile, transcriptReviewEnabled, visualAnalysisMode, visualSamplingLevel, executionMode, collectionMode } }));
    if (!results[0].meta.changes) throw new ProjectWriteAccessChangedError();
    waitUntil(collectVideoMetadata({ organizationId, projectId, userId: user.id, videoId }).catch(() => {
      console.warn("video_metadata_collection_interrupted", { videoId });
    }));
    return Response.json({ video: { id: videoId, platform: "douyin", source_type: "url", source_url: sourceUrl, title: payload.title?.trim() || null, status: "pending", created_at: now }, job: { id: jobId, video_id: videoId, status: "pending", analysis_profile: analysisProfile, visual_analysis_mode: visualAnalysisMode, visual_sampling_level: visualSamplingLevel, execution_mode: executionMode, collection_mode: collectionMode, transcript_review_enabled: transcriptReviewEnabled, progress: 0, current_stage: "等待进入分析队列", retry_count: 0, created_at: now, updated_at: now } }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiError(error.code, error.message, error.status);
    if (error instanceof ProjectWriteAccessChangedError) return apiError(error.code, "登录状态或项目权限已改变，本次资料未保存。请刷新确认权限后重新提交。", 403);
    if (isAnalysisSubmissionConflict(error)) return apiError("VIDEO_SUBMISSION_CONFLICT", "相同素材已被其他成员提交。本次没有新建分析任务，请刷新列表；若素材在其他项目，再次提交即可复用。", 409);
    return errorResponse(error);
  }
}
