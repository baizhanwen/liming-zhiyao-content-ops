import { z } from "zod";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { isPublicOwnedWork, scorePublishedWorkCandidate } from "../../../../lib/published-work-matching";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

type WorkRow = {
  id: string; platform_work_id: string | null; title: string; published_at: string; genre: string | null; review_status: string | null;
  video_id: string | null; match_status: string; match_confidence: number | null; match_method: string | null; matched_at: string | null;
  views: number; likes: number; comments: number; shares: number; saves: number; homepage_visits: number; follower_delta: number;
};

type VideoRow = {
  id: string; platform_work_id: string | null; title: string | null; published_at: string | null; duration_sec: number | null;
  source_url: string | null; analysis_id: string; analysis_created_at: string;
};

const mutationSchema = z.object({
  organizationId: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  workId: z.string().trim().min(1).max(200),
  videoId: z.string().trim().min(1).max(200).nullable(),
}).strict();

function presentVideo(video: VideoRow, score: ReturnType<typeof scorePublishedWorkCandidate>) {
  return {
    id: video.id, platformWorkId: video.platform_work_id, title: video.title || "未命名视频", publishedAt: video.published_at,
    durationSec: video.duration_sec, sourceUrl: video.source_url, analysisId: video.analysis_id, analysisCreatedAt: video.analysis_created_at,
    confidence: score.score, method: score.method, reason: score.reason,
  };
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再匹配作品。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或企业空间范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该企业空间的作品。", 403);
    const db = getD1();
    const [worksResult, videosResult] = await Promise.all([
      db.prepare(`
        SELECT w.id, w.platform_work_id, w.title, w.published_at, w.genre, w.review_status, w.video_id, w.match_status,
          w.match_confidence, w.match_method, w.matched_at,
          COALESCE(s.views, 0) AS views, COALESCE(s.likes, 0) AS likes, COALESCE(s.comments, 0) AS comments,
          COALESCE(s.shares, 0) AS shares, COALESCE(s.saves, 0) AS saves, COALESCE(s.homepage_visits, 0) AS homepage_visits,
          COALESCE(s.follower_delta, 0) AS follower_delta
        FROM platform_works w
        LEFT JOIN platform_metric_snapshots s ON s.id = (
          SELECT latest.id FROM platform_metric_snapshots latest
          INNER JOIN platform_metric_import_batches batch ON batch.id = latest.import_batch_id AND batch.status = 'completed'
          WHERE latest.organization_id = w.organization_id AND latest.project_id = w.project_id AND latest.work_id = w.id
          ORDER BY latest.as_of_at DESC LIMIT 1
        )
        WHERE w.organization_id = ? AND w.project_id = ? AND w.platform = 'douyin'
        ORDER BY w.published_at DESC LIMIT 500
      `).bind(organizationId, projectId).all<WorkRow>(),
      db.prepare(`
        SELECT v.id, v.platform_work_id, v.title, v.published_at, v.duration_sec, v.source_url,
          a.id AS analysis_id, a.created_at AS analysis_created_at
        FROM videos v
        INNER JOIN video_analyses a ON a.id = (
          SELECT latest.id FROM video_analyses latest
          WHERE latest.organization_id = v.organization_id AND latest.project_id = v.project_id AND latest.video_id = v.id
          ORDER BY latest.created_at DESC LIMIT 1
        )
        WHERE v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL AND v.status = 'ready'
        ORDER BY a.created_at DESC LIMIT 500
      `).bind(organizationId, projectId).all<VideoRow>(),
    ]);
    const publicWorks = worksResult.results.filter((work) => isPublicOwnedWork(work.review_status));
    const matchedVideoIds = new Set(publicWorks.map((work) => work.video_id).filter((value): value is string => Boolean(value)));
    const works = publicWorks.map((work) => {
      const current = work.video_id ? videosResult.results.find((video) => video.id === work.video_id) : undefined;
      const candidates = videosResult.results
        .filter((video) => video.id === work.video_id || !matchedVideoIds.has(video.id))
        .map((video) => ({ video, score: scorePublishedWorkCandidate({ platformWorkId: work.platform_work_id, title: work.title, publishedAt: work.published_at }, { id: video.id, platformWorkId: video.platform_work_id, title: video.title || "", publishedAt: video.published_at, durationSec: video.duration_sec }) }))
        .filter((item) => item.video.id === work.video_id || item.score.score >= 35)
        .sort((left, right) => right.score.score - left.score.score)
        .slice(0, 3)
        .map((item) => presentVideo(item.video, item.score));
      return {
        id: work.id, platformWorkId: work.platform_work_id, title: work.title, publishedAt: work.published_at, genre: work.genre,
        reviewStatus: work.review_status, matchStatus: work.video_id ? "confirmed" : "unmatched", matchConfidence: work.match_confidence,
        matchMethod: work.match_method, matchedAt: work.matched_at,
        metrics: { views: work.views, likes: work.likes, comments: work.comments, shares: work.shares, saves: work.saves, homepageVisits: work.homepage_visits, followerDelta: work.follower_delta },
        matchedVideo: current ? presentVideo(current, scorePublishedWorkCandidate({ platformWorkId: work.platform_work_id, title: work.title, publishedAt: work.published_at }, { id: current.id, platformWorkId: current.platform_work_id, title: current.title || "", publishedAt: current.published_at })) : null,
        candidates,
      };
    });
    return Response.json({
      works,
      summary: { total: works.length, confirmed: works.filter((work) => work.matchedVideo).length, suggested: works.filter((work) => !work.matchedVideo && work.candidates.length > 0).length, unmatched: works.filter((work) => !work.matchedVideo && !work.candidates.length).length, analyzedVideos: videosResult.results.length },
      canWrite: canWriteProjectAccess(access),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再确认作品。", 401);
  try {
    const parsed = mutationSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_WORK_MATCH", parsed.error.issues[0]?.message || "作品匹配参数无效。", 400);
    const { organizationId, projectId, workId, videoId } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能确认作品匹配。", 403);
    const db = getD1(); const user = await ensureUser(identity); const now = new Date().toISOString();
    const work = await db.prepare("SELECT id, platform_work_id, title, published_at FROM platform_works WHERE id = ? AND organization_id = ? AND project_id = ?").bind(workId, organizationId, projectId).first<{ id: string; platform_work_id: string | null; title: string; published_at: string }>();
    if (!work) return apiError("PLATFORM_WORK_NOT_FOUND", "没有找到当前企业空间中的作品。", 404);
    if (!videoId) {
      await db.batch([
        db.prepare("UPDATE platform_works SET video_id = NULL, match_status = 'unmatched', match_confidence = NULL, match_method = NULL, matched_by = NULL, matched_at = NULL, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(user.id, now, workId, organizationId, projectId),
        db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, 'performance.work_video_unmatched', 'platform_work', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, workId, now),
      ]);
      return Response.json({ matched: false, workId });
    }
    const video = await db.prepare(`
      SELECT v.id, v.platform_work_id, v.title, v.published_at, v.duration_sec
      FROM videos v WHERE v.id = ? AND v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM video_analyses a WHERE a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.video_id = v.id)
    `).bind(videoId, organizationId, projectId).first<{ id: string; platform_work_id: string | null; title: string | null; published_at: string | null; duration_sec: number | null }>();
    if (!video) return apiError("ANALYZED_VIDEO_NOT_FOUND", "所选视频不在当前企业空间，或尚未完成分析。", 404);
    const conflict = await db.prepare("SELECT id FROM platform_works WHERE organization_id = ? AND project_id = ? AND video_id = ? AND id <> ? LIMIT 1").bind(organizationId, projectId, videoId, workId).first<{ id: string }>();
    if (conflict) return apiError("VIDEO_ALREADY_MATCHED", "这条视频已经绑定到另一条作品。", 409);
    const score = scorePublishedWorkCandidate({ platformWorkId: work.platform_work_id, title: work.title, publishedAt: work.published_at }, { id: video.id, platformWorkId: video.platform_work_id, title: video.title || "", publishedAt: video.published_at, durationSec: video.duration_sec });
    await db.batch([
      db.prepare("UPDATE platform_works SET video_id = ?, platform_work_id = COALESCE(platform_work_id, ?), match_status = 'confirmed', match_confidence = ?, match_method = ?, matched_by = ?, matched_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(videoId, video.platform_work_id, score.score, score.method, user.id, now, user.id, now, workId, organizationId, projectId),
      db.prepare("INSERT OR IGNORE INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, notes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'published', '[]', NULL, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, videoId, user.id, user.id, now, now),
      db.prepare("UPDATE video_library_entries SET category = 'published', updated_by = ?, updated_at = ? WHERE organization_id = ? AND source_video_id = ?").bind(user.id, now, organizationId, videoId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'performance.work_video_matched', 'platform_work', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, workId, JSON.stringify({ videoId, confidence: score.score, method: score.method }), now),
    ]);
    return Response.json({ matched: true, workId, videoId, confidence: score.score, method: score.method });
  } catch (error) { return errorResponse(error); }
}
