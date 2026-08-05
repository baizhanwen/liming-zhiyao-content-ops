import { z } from "zod";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { checkOrganizationQuota } from "../../../../../lib/operations";
import { readRequestIdentity } from "../../../../../lib/request-auth";

const segmentSchema = z.object({
  startMs: z.number().int().min(0).max(86_400_000),
  endMs: z.number().int().min(0).max(86_400_000),
  text: z.string().trim().min(1).max(2_000),
});

const correctionSchema = z.object({
  organizationId: z.string().uuid(), projectId: z.string().uuid(), language: z.string().trim().min(2).max(32).default("zh-CN"),
  segments: z.array(segmentSchema).min(1).max(5_000), reanalyze: z.boolean().default(false),
});

const activeStatuses = ["pending", "queued", "downloading", "processing", "transcribing", "extracting", "analyzing"];

export async function POST(request: Request, context: { params: Promise<{ videoId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请登录后再校正转写。", 401);
  try {
    const parsed = correctionSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_TRANSCRIPT", "转写片段格式无效，单段不能超过 2000 字。", 400);
    const { organizationId, projectId, language, segments, reanalyze } = parsed.data;
    for (let index = 0; index < segments.length; index += 1) {
      const current = segments[index]; const previous = segments[index - 1];
      if (current.endMs < current.startMs || (previous && current.startMs < previous.startMs)) return apiError("INVALID_TIMELINE", "转写时间轴必须按开始时间排列，结束时间不能早于开始时间。", 400);
    }
    const fullText = segments.map((segment) => segment.text).join("\n"); const segmentsJson = JSON.stringify(segments.map((segment) => ({ start_ms: segment.startMs, end_ms: segment.endMs, text: segment.text, confidence: null })));
    if (fullText.length > 1_000_000 || segmentsJson.length > 1_000_000) return apiError("TRANSCRIPT_TOO_LARGE", "校正后的转写内容体积过大。", 413);
    const { videoId } = await context.params; const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能修改视频转写。", 403);
    const user = await ensureUser(identity); const db = getD1(); const video = await db.prepare("SELECT id, source_type, source_url, media_asset_id FROM videos WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(videoId, organizationId, projectId).first<{ id: string; source_type: "url" | "upload"; source_url: string | null; media_asset_id: string | null }>();
    if (!video) return apiError("VIDEO_NOT_FOUND", "视频不存在或不属于当前项目。", 404);
    if (reanalyze) {
      const quota = await checkOrganizationQuota(organizationId, user.id, "analyses");
      if (!quota.allowed) return apiError("ANALYSIS_QUOTA_EXCEEDED", `本月分析任务额度已用完（${quota.current}/${quota.limit}）。`, 429);
      const active = await db.prepare(`SELECT id FROM analysis_jobs WHERE organization_id = ? AND project_id = ? AND video_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")}) LIMIT 1`).bind(organizationId, projectId, videoId, ...activeStatuses).first();
      if (active) return apiError("ANALYSIS_ALREADY_RUNNING", "当前视频已有分析任务正在运行，请等待完成后再重新分析。", 409);
    }
    const now = new Date().toISOString(); const transcriptId = crypto.randomUUID(); const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM video_transcripts WHERE organization_id = ? AND project_id = ? AND video_id = ?").bind(organizationId, projectId, videoId).first<{ value: number }>(); const version = (latest?.value ?? 0) + 1;
    const statements = [
      db.prepare("INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source, full_text, segments_json, confidence, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, NULL, ?, ?, ?)").bind(transcriptId, organizationId, projectId, videoId, version, language, fullText, segmentsJson, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video.transcript_corrected', 'video_transcript', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, transcriptId, JSON.stringify({ videoId, version, segmentCount: segments.length, reanalyze }), now),
    ];
    let job: Record<string, unknown> | null = null;
    if (reanalyze) {
      const sourceRef = video.source_type === "upload" ? video.media_asset_id : video.source_url;
      if (!sourceRef) return apiError("SOURCE_UNAVAILABLE", "原始媒体来源不存在，无法重新分析。", 409);
      const jobId = crypto.randomUUID();
      statements.push(
        db.prepare("INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, input_transcript_id, source_type, source_ref, idempotency_key, status, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, '等待使用人工校正版重新分析', 0, ?, ?, ?, ?)").bind(jobId, organizationId, projectId, videoId, transcriptId, video.source_type, sourceRef, `manual:${transcriptId}`, user.id, user.id, now, now),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'analysis_job.manual_reanalysis_created', 'analysis_job', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, jobId, JSON.stringify({ videoId, transcriptId, transcriptVersion: version }), now),
      );
      job = { id: jobId, video_id: videoId, status: "pending", progress: 0, current_stage: "等待使用人工校正版重新分析", retry_count: 0, created_at: now, updated_at: now };
    }
    await db.batch(statements);
    return Response.json({ transcript: { id: transcriptId, version, language, source: "manual", full_text: fullText, segments, confidence: null, created_at: now, updated_at: now }, job }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
