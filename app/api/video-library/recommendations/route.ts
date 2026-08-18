import { canAccessOrganizationVideoLibrary, getD1, getOrganizationAccess, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { analysisReportSourceText } from "../../../../lib/content-production";
import { recommendMaterials, type MaterialFeedback, type MaterialPerformance, type MaterialRecommendationCandidate } from "../../../../lib/material-recommendation";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

type TopicRow = {
  title: string;
  angle: string | null;
  pillar: string | null;
  audience: string | null;
  objective: string | null;
  hook: string | null;
  rationale: string | null;
};

type StrategyRow = {
  positioning: string | null;
  persona: string | null;
  target_audience: string | null;
  pain_points_json: string | null;
  pillars_json: string | null;
  style_notes: string | null;
  conversion_path: string | null;
  objectives_json: string | null;
};

type CandidateRow = {
  id: string;
  category: string;
  tags_json: string;
  notes: string | null;
  title: string | null;
  author_name: string | null;
  analysis_id: string;
  report_json: string;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  followers_gained: number | null;
};

type FeedbackRow = {
  entry_id: string;
  usage_count: number;
  manual_revision_count: number;
  approved_count: number;
  changes_requested_count: number;
  comment_count: number;
  published_count: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  followers_gained: number;
  leads: number;
  completion_rate_bps: number;
};

function parseTags(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 12) : [];
  } catch { return []; }
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function feedbackFrom(row?: FeedbackRow): MaterialFeedback {
  return {
    usageCount: numberValue(row?.usage_count),
    manualRevisionCount: numberValue(row?.manual_revision_count),
    approvedCount: numberValue(row?.approved_count),
    changesRequestedCount: numberValue(row?.changes_requested_count),
    commentCount: numberValue(row?.comment_count),
    publishedCount: numberValue(row?.published_count),
    performance: {
      views: numberValue(row?.views), likes: numberValue(row?.likes), comments: numberValue(row?.comments), shares: numberValue(row?.shares), saves: numberValue(row?.saves),
      followersGained: numberValue(row?.followers_gained), leads: numberValue(row?.leads), completionRateBps: numberValue(row?.completion_rate_bps),
    },
  };
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再获取素材推荐。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const contentId = url.searchParams.get("contentId")?.trim() ?? "";
  if (!organizationId || !projectId || !contentId) return apiError("RECOMMENDATION_SCOPE_REQUIRED", "缺少公司、项目或内容任务范围。", 400);
  try {
    const [organizationAccess, projectAccess] = await Promise.all([
      getOrganizationAccess(identity.authSubject, organizationId),
      getProjectAccess(identity.authSubject, organizationId, projectId),
    ]);
    if (!projectAccess) return apiError("PROJECT_ACCESS_DENIED", "当前账号不能访问该客户项目。", 403);
    if (!organizationAccess || !await canAccessOrganizationVideoLibrary(organizationAccess)) return apiError("LIBRARY_ACCESS_DENIED", "当前角色不能跨项目检索公司素材中心。", 403);
    const db = getD1();
    const [topic, strategy, candidateRows, feedbackRows] = await Promise.all([
      db.prepare(`SELECT t.title, t.angle, t.pillar, t.audience, t.objective, t.hook, t.rationale
        FROM content_items c INNER JOIN topic_ideas t ON t.id = c.topic_id AND t.organization_id = c.organization_id AND t.project_id = c.project_id
        WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL`).bind(contentId, organizationId, projectId).first<TopicRow>(),
      db.prepare(`SELECT positioning, persona, target_audience, pain_points_json, pillars_json, style_notes, conversion_path, objectives_json
        FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`).bind(organizationId, projectId).first<StrategyRow>(),
      db.prepare(`SELECT library.id, library.category, library.tags_json, library.notes, v.title, v.author_name,
          analysis.id AS analysis_id, analysis.report_json,
          metrics.plays, metrics.likes, metrics.comments, metrics.favorites, metrics.shares, metrics.followers_gained
        FROM video_library_entries library
        INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
        INNER JOIN video_analyses analysis ON analysis.id = (
          SELECT latest.id FROM video_analyses latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1
        )
        LEFT JOIN video_metric_snapshots metrics ON metrics.id = (
          SELECT latest_metric.id FROM video_metric_snapshots latest_metric WHERE latest_metric.organization_id = v.organization_id AND latest_metric.video_id = v.id ORDER BY latest_metric.collected_at DESC, latest_metric.created_at DESC LIMIT 1
        )
        WHERE library.organization_id = ? AND v.status != 'archived'
        ORDER BY library.updated_at DESC LIMIT 300`).bind(organizationId).all<CandidateRow>(),
      db.prepare(`WITH cited AS (
          SELECT DISTINCT citation_id AS entry_id, content_item_id
          FROM content_citations
          WHERE organization_id = ? AND project_id = ? AND citation_type = 'benchmark'
        ), version_feedback AS (
          SELECT cc.citation_id AS entry_id,
            COUNT(DISTINCT cc.content_item_id) AS usage_count,
            COUNT(DISTINCT CASE WHEN cv.generation_mode = 'manual' THEN cv.id END) AS manual_revision_count
          FROM content_citations cc INNER JOIN content_versions cv ON cv.id = cc.content_version_id
          WHERE cc.organization_id = ? AND cc.project_id = ? AND cc.citation_type = 'benchmark'
          GROUP BY cc.citation_id
        ), review_feedback AS (
          SELECT cited.entry_id,
            COUNT(DISTINCT CASE WHEN r.decision = 'approved' THEN r.id END) AS approved_count,
            COUNT(DISTINCT CASE WHEN r.decision = 'changes_requested' THEN r.id END) AS changes_requested_count
          FROM cited LEFT JOIN content_reviews r ON r.content_item_id = cited.content_item_id AND r.organization_id = ? AND r.project_id = ?
          GROUP BY cited.entry_id
        ), comment_feedback AS (
          SELECT cited.entry_id, COUNT(DISTINCT comments.id) AS comment_count
          FROM cited LEFT JOIN content_comments comments ON comments.content_item_id = cited.content_item_id AND comments.organization_id = ? AND comments.project_id = ? AND comments.deleted_at IS NULL
          GROUP BY cited.entry_id
        ), publication_feedback AS (
          SELECT cited.entry_id, COUNT(DISTINCT publications.id) AS published_count,
            COALESCE(SUM(metrics.views), 0) AS views, COALESCE(SUM(metrics.likes), 0) AS likes, COALESCE(SUM(metrics.comments), 0) AS comments,
            COALESCE(SUM(metrics.shares), 0) AS shares, COALESCE(SUM(metrics.saves), 0) AS saves,
            COALESCE(SUM(metrics.followers_gained), 0) AS followers_gained, COALESCE(SUM(metrics.leads), 0) AS leads,
            COALESCE(MAX(metrics.completion_rate_bps), 0) AS completion_rate_bps
          FROM cited
          LEFT JOIN publication_records publications ON publications.content_item_id = cited.content_item_id AND publications.organization_id = ? AND publications.project_id = ? AND publications.status = 'published'
          LEFT JOIN publication_metric_snapshots metrics ON metrics.id = (
            SELECT latest.id FROM publication_metric_snapshots latest WHERE latest.publication_id = publications.id ORDER BY latest.observed_at DESC, latest.created_at DESC LIMIT 1
          )
          GROUP BY cited.entry_id
        )
        SELECT vf.entry_id, vf.usage_count, vf.manual_revision_count,
          COALESCE(rf.approved_count, 0) AS approved_count, COALESCE(rf.changes_requested_count, 0) AS changes_requested_count,
          COALESCE(cf.comment_count, 0) AS comment_count, COALESCE(pf.published_count, 0) AS published_count,
          COALESCE(pf.views, 0) AS views, COALESCE(pf.likes, 0) AS likes, COALESCE(pf.comments, 0) AS comments,
          COALESCE(pf.shares, 0) AS shares, COALESCE(pf.saves, 0) AS saves, COALESCE(pf.followers_gained, 0) AS followers_gained,
          COALESCE(pf.leads, 0) AS leads, COALESCE(pf.completion_rate_bps, 0) AS completion_rate_bps
        FROM version_feedback vf
        LEFT JOIN review_feedback rf ON rf.entry_id = vf.entry_id
        LEFT JOIN comment_feedback cf ON cf.entry_id = vf.entry_id
        LEFT JOIN publication_feedback pf ON pf.entry_id = vf.entry_id`).bind(
          organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId,
        ).all<FeedbackRow>(),
    ]);
    if (!topic) return apiError("CONTENT_NOT_FOUND", "内容任务不存在。", 404);
    const feedback = new Map(feedbackRows.results.map((row) => [row.entry_id, feedbackFrom(row)]));
    const candidates: MaterialRecommendationCandidate[] = candidateRows.results.map((row) => {
      const directPerformance: MaterialPerformance = {
        views: numberValue(row.plays), likes: numberValue(row.likes), comments: numberValue(row.comments), shares: numberValue(row.shares), saves: numberValue(row.favorites), followersGained: numberValue(row.followers_gained),
      };
      return {
        id: row.id,
        title: row.title?.trim() || "未命名素材",
        authorName: row.author_name,
        category: row.category,
        tags: parseTags(row.tags_json),
        notes: row.notes,
        analysisText: analysisReportSourceText(row.report_json),
        directPerformance,
        feedback: feedback.get(row.id) ?? feedbackFrom(),
      };
    });
    const context = {
      topic: [topic.title, topic.angle, topic.pillar, topic.rationale, strategy?.positioning, strategy?.pillars_json].filter(Boolean).join("\n"),
      audience: [topic.audience, strategy?.persona, strategy?.target_audience, strategy?.pain_points_json].filter(Boolean).join("\n"),
      structure: [topic.hook, topic.angle, topic.rationale, strategy?.style_notes].filter(Boolean).join("\n"),
      conversion: [topic.objective, strategy?.conversion_path, strategy?.objectives_json].filter(Boolean).join("\n"),
    };
    const recommendation = recommendMaterials(candidates, context, 5);
    return Response.json({
      recommendedIds: recommendation.recommendedIds,
      entries: recommendation.entries.slice(0, 50).map((entry) => ({
        id: entry.id, title: entry.title, author_name: entry.authorName, category: entry.category, tags: entry.tags,
        score: entry.score, scores: entry.scores, reasons: entry.reasons, matchedTerms: entry.matchedTerms,
        hasOutcomeData: entry.hasOutcomeData, recommended: entry.recommended, feedback: entry.feedback,
      })),
      context: { topic: topic.title, candidateCount: candidates.length },
    });
  } catch (error) { return errorResponse(error); }
}
