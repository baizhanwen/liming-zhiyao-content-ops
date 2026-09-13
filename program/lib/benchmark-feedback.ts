import type { MaterialFeedback } from "./material-recommendation.ts";

export type BenchmarkFeedbackRow = {
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

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function materialFeedbackFromRow(row?: BenchmarkFeedbackRow): MaterialFeedback {
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

export async function readBenchmarkFeedback(db: Pick<D1Database, "prepare">, input: { organizationId: string; projectId: string; entryIds?: readonly string[] }) {
  if (input.entryIds?.length === 0) return { results: [] as BenchmarkFeedbackRow[] };
  const { organizationId, projectId } = input;
  return db.prepare(`WITH cited AS (
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
        LEFT JOIN publication_feedback pf ON pf.entry_id = vf.entry_id
        ${input.entryIds ? `WHERE vf.entry_id IN (${input.entryIds.map(() => "?").join(", ")})` : ""}`).bind(
          organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, ...(input.entryIds ?? []),
        ).all<BenchmarkFeedbackRow>();
}
