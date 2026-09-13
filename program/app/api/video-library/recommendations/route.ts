import { readBenchmarkFeedback, materialFeedbackFromRow } from "../../../../lib/benchmark-feedback";
import { getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { analysisReportSourceText } from "../../../../lib/content-production";
import { recommendMaterials, type MaterialPerformance, type MaterialRecommendationCandidate } from "../../../../lib/material-recommendation";
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


export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再获取素材推荐。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const contentId = url.searchParams.get("contentId")?.trim() ?? "";
  if (!organizationId || !projectId || !contentId) return apiError("RECOMMENDATION_SCOPE_REQUIRED", "缺少公司、项目或内容任务范围。", 400);
  try {
    const projectAccess = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!projectAccess) return apiError("PROJECT_ACCESS_DENIED", "当前账号不能访问该企业空间。", 403);
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
        FROM project_video_references refs
        INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
        INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
        INNER JOIN video_analyses analysis ON analysis.id = (
          SELECT latest.id FROM video_analyses latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1
        )
        LEFT JOIN video_metric_snapshots metrics ON metrics.id = (
          SELECT latest_metric.id FROM video_metric_snapshots latest_metric WHERE latest_metric.organization_id = v.organization_id AND latest_metric.video_id = v.id ORDER BY latest_metric.collected_at DESC, latest_metric.created_at DESC LIMIT 1
        )
        WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active' AND v.status != 'archived'
        ORDER BY analysis.created_at DESC, refs.created_at DESC LIMIT 300`).bind(organizationId, projectId).all<CandidateRow>(),
      readBenchmarkFeedback(db, { organizationId, projectId }),
    ]);
    if (!topic) return apiError("CONTENT_NOT_FOUND", "内容任务不存在。", 404);
    const feedback = new Map(feedbackRows.results.map((row) => [row.entry_id, materialFeedbackFromRow(row)]));
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
        feedback: feedback.get(row.id) ?? materialFeedbackFromRow(),
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
      context: { topic: topic.title, candidateCount: candidates.length, materialScope: "project_benchmark" },
    });
  } catch (error) { return errorResponse(error); }
}
