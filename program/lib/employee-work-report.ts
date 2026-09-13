import { z } from "zod";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const createEmployeeWorkReportSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  employeeUserId: z.string().min(1),
  reportType: z.enum(["weekly", "monthly", "custom"]),
  periodStart: z.string().regex(isoDate, "开始日期无效。"),
  periodEnd: z.string().regex(isoDate, "结束日期无效。"),
  title: z.string().trim().max(200).optional(),
}).refine((value) => value.periodStart <= value.periodEnd, { path: ["periodEnd"], message: "结束日期不能早于开始日期。" });

type AnalysisRow = { job_id: string; video_id: string | null; title: string | null; source_ref: string; status: string; created_at: string; completed_at: string | null };
type ContentRow = { content_item_id: string; title: string; status: string; created_at: string; version_count: number; last_version_at: string | null };
type CountRow = { count: number };
type WorkRow = { work_id: string; content_item_id: string | null; owner_user_id: string | null; title: string; published_at: string; video_id: string | null; views: number; likes: number; shares: number; comments: number; saves: number; follower_delta: number };

export type EmployeeWorkReportSnapshot = {
  employee: { id: string; name: string };
  period: { start: string; end: string };
  summary: {
    analysesStarted: number; analysesCompleted: number; analysesFailed: number;
    contentOwned: number; versionsCreated: number; reviewsCompleted: number; publishingActions: number;
    attributedPublishedWorks: number; highPerformingWorks: number; viralWorks: number;
  };
  summaryText: string;
  analyses: Array<{ jobId: string; videoId: string | null; title: string; status: string; startedAt: string; completedAt: string | null }>;
  content: Array<{ contentItemId: string; title: string; status: string; createdAt: string; versionsCreated: number; lastVersionAt: string | null }>;
  outcomes: Array<{ workId: string; contentItemId: string; title: string; publishedAt: string; videoId: string | null; views: number; interactions: number; engagementRate: number; followerDelta: number; label: "viral" | "high" | "regular" | "insufficient"; reason: string }>;
  benchmark: { cohortSize: number; minimumHighSample: number; minimumViralSample: number; p80Views: number | null; p90Views: number | null; medianEngagementRate: number | null; p75EngagementRate: number | null; rule: string };
  attribution: { unmatchedPublishedWorks: number; note: string };
};

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position); const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function numberValue(value: unknown) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }

export async function loadEmployeeWorkReport(db: D1Database, input: { organizationId: string; projectId: string; employeeUserId: string; employeeName: string; periodStart: string; periodEnd: string }): Promise<EmployeeWorkReportSnapshot> {
  const { organizationId, projectId, employeeUserId, employeeName, periodStart, periodEnd } = input;
  const analysesResult = await db.prepare(`
    SELECT aj.id AS job_id, aj.video_id, v.title, aj.source_ref, aj.status, aj.created_at, aj.completed_at
    FROM analysis_jobs aj LEFT JOIN videos v ON v.id = aj.video_id
    WHERE aj.organization_id = ? AND aj.project_id = ? AND aj.created_by = ?
      AND substr(aj.created_at, 1, 10) BETWEEN ? AND ?
    ORDER BY aj.created_at DESC LIMIT 100
  `).bind(organizationId, projectId, employeeUserId, periodStart, periodEnd).all<AnalysisRow>();

  const contentResult = await db.prepare(`
    SELECT ci.id AS content_item_id, ci.title, ci.status, ci.created_at,
      COUNT(ev.id) AS version_count, MAX(ev.created_at) AS last_version_at
    FROM content_items ci
    LEFT JOIN content_versions ev ON ev.content_item_id = ci.id AND ev.created_by = ? AND substr(ev.created_at, 1, 10) BETWEEN ? AND ?
    WHERE ci.organization_id = ? AND ci.project_id = ? AND ci.deleted_at IS NULL
      AND COALESCE(ci.assignee_user_id, ci.created_by) = ?
      AND (substr(ci.created_at, 1, 10) BETWEEN ? AND ? OR ev.id IS NOT NULL)
    GROUP BY ci.id ORDER BY COALESCE(MAX(ev.created_at), ci.created_at) DESC LIMIT 100
  `).bind(employeeUserId, periodStart, periodEnd, organizationId, projectId, employeeUserId, periodStart, periodEnd).all<ContentRow>();

  const versions = await db.prepare("SELECT COUNT(*) AS count FROM content_versions WHERE organization_id = ? AND project_id = ? AND created_by = ? AND substr(created_at, 1, 10) BETWEEN ? AND ?").bind(organizationId, projectId, employeeUserId, periodStart, periodEnd).first<CountRow>();
  const reviews = await db.prepare("SELECT COUNT(*) AS count FROM content_reviews WHERE organization_id = ? AND project_id = ? AND decided_by = ? AND decided_at IS NOT NULL AND substr(decided_at, 1, 10) BETWEEN ? AND ?").bind(organizationId, projectId, employeeUserId, periodStart, periodEnd).first<CountRow>();
  const publications = await db.prepare("SELECT COUNT(*) AS count FROM publication_records WHERE organization_id = ? AND project_id = ? AND created_by = ? AND status = 'published' AND substr(COALESCE(published_at, created_at), 1, 10) BETWEEN ? AND ?").bind(organizationId, projectId, employeeUserId, periodStart, periodEnd).first<CountRow>();

  const worksResult = await db.prepare(`
    WITH latest AS (
      SELECT pms.work_id, MAX(pms.as_of_at) AS as_of_at
      FROM platform_metric_snapshots pms
      WHERE pms.organization_id = ? AND pms.project_id = ?
      GROUP BY pms.work_id
    )
    SELECT pw.id AS work_id, pw.content_item_id, COALESCE(ci.assignee_user_id, ci.created_by) AS owner_user_id, pw.title, pw.published_at, pw.video_id,
      pms.views, pms.likes, pms.shares, pms.comments, pms.saves, pms.follower_delta
    FROM platform_works pw
    INNER JOIN latest ON latest.work_id = pw.id
    INNER JOIN platform_metric_snapshots pms ON pms.work_id = latest.work_id AND pms.as_of_at = latest.as_of_at
    LEFT JOIN content_items ci ON ci.id = pw.content_item_id AND ci.deleted_at IS NULL
    WHERE pw.organization_id = ? AND pw.project_id = ? AND substr(pw.published_at, 1, 10) BETWEEN ? AND ?
    ORDER BY pms.views DESC
  `).bind(organizationId, projectId, organizationId, projectId, periodStart, periodEnd).all<WorkRow>();

  const works = worksResult.results.map((row) => {
    const interactions = numberValue(row.likes) + numberValue(row.shares) + numberValue(row.comments) + numberValue(row.saves);
    const views = numberValue(row.views);
    return { ...row, views, interactions, engagementRate: views > 0 ? interactions / views : 0 };
  });
  const p80Views = percentile(works.map((work) => work.views), .8);
  const p90Views = percentile(works.map((work) => work.views), .9);
  const medianEngagementRate = percentile(works.map((work) => work.engagementRate), .5);
  const p75EngagementRate = percentile(works.map((work) => work.engagementRate), .75);
  const ownedWorks = works.filter((work) => work.content_item_id && work.owner_user_id === employeeUserId);
  const outcomes = ownedWorks.map((work) => {
    let label: "viral" | "high" | "regular" | "insufficient" = works.length < 5 ? "insufficient" : "regular";
    if (works.length >= 10 && p90Views !== null && p75EngagementRate !== null && work.views >= p90Views && work.engagementRate >= p75EngagementRate) label = "viral";
    else if (works.length >= 5 && p80Views !== null && medianEngagementRate !== null && work.views >= p80Views && work.engagementRate >= medianEngagementRate) label = "high";
    const reason = label === "viral" ? "播放进入本期前10%，且互动率不低于前25%门槛。" : label === "high" ? "播放进入本期前20%，且互动率不低于中位数。" : label === "insufficient" ? `本期仅 ${works.length} 条可比作品，暂不做高表现判定。` : "未同时达到播放与互动的双重门槛。";
    return { workId: work.work_id, contentItemId: work.content_item_id!, title: work.title, publishedAt: work.published_at, videoId: work.video_id, views: work.views, interactions: work.interactions, engagementRate: work.engagementRate, followerDelta: numberValue(work.follower_delta), label, reason };
  });
  const analyses = analysesResult.results;
  const highCount = outcomes.filter((item) => item.label === "high").length;
  const viralCount = outcomes.filter((item) => item.label === "viral").length;
  const summary = {
    analysesStarted: analyses.length,
    analysesCompleted: analyses.filter((item) => item.status === "completed" || item.status === "partial").length,
    analysesFailed: analyses.filter((item) => item.status === "failed" || item.status === "cancelled").length,
    contentOwned: contentResult.results.length,
    versionsCreated: numberValue(versions?.count),
    reviewsCompleted: numberValue(reviews?.count),
    publishingActions: numberValue(publications?.count),
    attributedPublishedWorks: outcomes.length,
    highPerformingWorks: highCount,
    viralWorks: viralCount,
  };
  return {
    employee: { id: employeeUserId, name: employeeName }, period: { start: periodStart, end: periodEnd }, summary,
    summaryText: `${employeeName}本期发起 ${summary.analysesStarted} 个视频分析，完成 ${summary.analysesCompleted} 个；主创或负责 ${summary.contentOwned} 个内容任务，产出 ${summary.versionsCreated} 个内容版本。${outcomes.length ? `已归因 ${outcomes.length} 条发布作品，其中 ${highCount} 条达到高表现标准${viralCount ? `、${viralCount} 条达到爆款标准` : ""}。` : "当前还没有可回溯到本人内容任务的发布作品。"}`,
    analyses: analyses.map((item) => ({ jobId: item.job_id, videoId: item.video_id, title: item.title?.trim() || item.source_ref, status: item.status, startedAt: item.created_at, completedAt: item.completed_at })),
    content: contentResult.results.map((item) => ({ contentItemId: item.content_item_id, title: item.title, status: item.status, createdAt: item.created_at, versionsCreated: numberValue(item.version_count), lastVersionAt: item.last_version_at })),
    outcomes,
    benchmark: { cohortSize: works.length, minimumHighSample: 5, minimumViralSample: 10, p80Views, p90Views, medianEngagementRate, p75EngagementRate, rule: "高表现：同企业空间同周期播放前20%，且互动率不低于中位数；爆款：至少10条样本，播放前10%，且互动率进入前25%。" },
    attribution: { unmatchedPublishedWorks: works.filter((work) => !work.content_item_id).length, note: "分析按任务发起人统计；内容按负责人（未指定时按创建人）统计；发布结果仅在作品已匹配内容任务时归因。" },
  };
}
