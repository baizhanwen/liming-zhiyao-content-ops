import { z } from "zod";
import type { getD1 } from "../db/runtime";

const identifier = z.string().trim().min(1).max(200);
const nonNegativeInteger = z.coerce.number().int().min(0).max(2_147_483_647);
const signedInteger = z.coerce.number().int().min(-2_147_483_648).max(2_147_483_647);
const percentage = z.preprocess((value) => typeof value === "string" ? value.replaceAll("%", "").replaceAll("％", "").replaceAll(",", "").trim() : value, z.coerce.number().min(0).max(100));

export const performanceRowSchema = z.object({
  publicationId: identifier.optional(),
  externalUrl: z.union([z.url().max(2_000), z.literal("")]).optional(),
  observedAt: z.iso.datetime({ offset: true }),
  views: nonNegativeInteger,
  likes: nonNegativeInteger.default(0),
  comments: nonNegativeInteger.default(0),
  shares: nonNegativeInteger.default(0),
  saves: nonNegativeInteger.default(0),
  followersGained: nonNegativeInteger.default(0),
  leads: nonNegativeInteger.default(0),
  averageWatchSeconds: nonNegativeInteger.max(86_400).optional(),
  completionRate: z.coerce.number().min(0).max(100).optional(),
}).strict().refine((value) => Boolean(value.publicationId || value.externalUrl), { message: "每行必须提供 publicationId 或 externalUrl" });

export const performanceImportSchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  source: z.enum(["csv", "manual"]),
  filename: z.string().trim().max(300).optional(),
  rows: z.array(performanceRowSchema).min(1).max(500),
}).strict();

export const douyinMetricRowSchema = z.object({
  platformWorkId: identifier.optional(),
  title: z.string().trim().min(1).max(500),
  publishedAt: z.iso.datetime({ offset: true }),
  genre: z.string().trim().max(120).optional(),
  reviewStatus: z.string().trim().max(120).optional(),
  views: nonNegativeInteger,
  completionRate: percentage.optional(),
  fiveSecondCompletionRate: percentage.optional(),
  coverCtr: percentage.optional(),
  twoSecondBounceRate: percentage.optional(),
  avgWatchMs: nonNegativeInteger.max(86_400_000).optional(),
  likes: nonNegativeInteger.default(0),
  shares: nonNegativeInteger.default(0),
  comments: nonNegativeInteger.default(0),
  saves: nonNegativeInteger.default(0),
  homepageVisits: nonNegativeInteger.default(0),
  followerDelta: signedInteger.default(0),
}).strict();

export const douyinPerformanceImportSchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  source: z.enum(["csv", "manual"]),
  format: z.literal("douyin_16"),
  asOfAt: z.iso.datetime({ offset: true }),
  filename: z.string().trim().max(300).optional(),
  rows: z.array(douyinMetricRowSchema).min(1).max(500),
}).strict();

export const createReportSchema = z.object({
  organizationId: identifier,
  projectId: identifier,
  reportType: z.enum(["weekly", "monthly", "custom"]),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  title: z.string().trim().min(1).max(200).optional(),
}).strict().refine((value) => value.periodStart <= value.periodEnd, { message: "报告开始日期不能晚于结束日期" });

export const finalizeReportSchema = z.object({ organizationId: identifier, projectId: identifier }).strict();

export type MetricSnapshotRow = {
  publication_id: string; content_item_id: string; title: string; platform: string; external_url: string | null; published_at: string | null; observed_at: string;
  genre?: string | null; review_status?: string | null; views: number; likes: number; comments: number; shares: number; saves: number; followers_gained: number; leads: number; homepage_visits?: number; average_watch_seconds: number | null; completion_rate_bps: number | null; five_second_completion_rate_bps?: number | null; cover_ctr_bps?: number | null; two_second_bounce_rate_bps?: number | null;
};

export type AnalyticsSnapshot = ReturnType<typeof buildAnalyticsSnapshot>;

function safeRate(numerator: number, denominator: number) { return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0; }
function interactions(row: MetricSnapshotRow) { return row.likes + row.comments + row.shares + row.saves; }
function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const index = (sorted.length - 1) * ratio; const lower = Math.floor(index); const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function distribution(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => typeof value === "number");
  return { count: valid.length, p25: percentile(valid, 0.25), median: percentile(valid, 0.5), p75: percentile(valid, 0.75), simpleMean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null };
}

export function buildAnalyticsSnapshot(rows: MetricSnapshotRow[], periodStart: string, periodEnd: string) {
  const latest = new Map<string, MetricSnapshotRow>();
  const daily = new Map<string, MetricSnapshotRow>();
  for (const row of rows) {
    const current = latest.get(row.publication_id);
    if (!current || row.observed_at > current.observed_at) latest.set(row.publication_id, row);
    const dailyKey = `${row.publication_id}:${row.observed_at.slice(0, 10)}`; const dailyCurrent = daily.get(dailyKey);
    if (!dailyCurrent || row.observed_at > dailyCurrent.observed_at) daily.set(dailyKey, row);
  }
  const latestRows = Array.from(latest.values());
  const totals = latestRows.reduce((sum, row) => ({
    views: sum.views + row.views,
    interactions: sum.interactions + interactions(row),
    followersGained: sum.followersGained + row.followers_gained,
    leads: sum.leads + row.leads,
    homepageVisits: sum.homepageVisits + (row.homepage_visits || 0),
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0, homepageVisits: 0 });
  const completionRows = latestRows.filter((row) => row.completion_rate_bps !== null);
  const watchRows = latestRows.filter((row) => row.average_watch_seconds !== null);
  const summary = {
    ...totals,
    contentCount: latestRows.length,
    engagementRate: safeRate(totals.interactions, totals.views),
    leadRate: safeRate(totals.leads, totals.views),
    averageCompletionRate: completionRows.length ? completionRows.reduce((sum, row) => sum + (row.completion_rate_bps || 0), 0) / completionRows.length / 100 : null,
    averageWatchSeconds: watchRows.length ? watchRows.reduce((sum, row) => sum + (row.average_watch_seconds || 0), 0) / watchRows.length : null,
    weightedAverageWatchSeconds: (() => { const weighted = latestRows.filter((row) => row.average_watch_seconds !== null && row.views > 0); const views = weighted.reduce((sum, row) => sum + row.views, 0); return views ? weighted.reduce((sum, row) => sum + (row.average_watch_seconds || 0) * row.views, 0) / views : null; })(),
    homepageVisitRate: safeRate(totals.homepageVisits, totals.views),
    playToFollowerRate: safeRate(totals.followersGained, totals.views),
    homepageToFollowerRate: safeRate(totals.followersGained, totals.homepageVisits),
    completionRateDistribution: distribution(latestRows.map((row) => row.completion_rate_bps === null ? null : row.completion_rate_bps / 100)),
    fiveSecondCompletionRateDistribution: distribution(latestRows.map((row) => row.five_second_completion_rate_bps === null || row.five_second_completion_rate_bps === undefined ? null : row.five_second_completion_rate_bps / 100)),
    coverCtrDistribution: distribution(latestRows.map((row) => row.cover_ctr_bps === null || row.cover_ctr_bps === undefined ? null : row.cover_ctr_bps / 100)),
    twoSecondBounceRateDistribution: distribution(latestRows.map((row) => row.two_second_bounce_rate_bps === null || row.two_second_bounce_rate_bps === undefined ? null : row.two_second_bounce_rate_bps / 100)),
    funnel: ["coverClick", "twoSecondRetention", "fiveSecondRetention", "completion", "interaction", "homepageVisit", "follow"].map((stage) => ({ stage, note: "按作品快照分布展示；比率不求和" })),
  };
  const seriesMap = new Map<string, { date: string; views: number; interactions: number; followersGained: number; leads: number }>();
  for (const row of daily.values()) { const date = row.observed_at.slice(0, 10); const current = seriesMap.get(date) || { date, views: 0, interactions: 0, followersGained: 0, leads: 0 }; current.views += row.views; current.interactions += interactions(row); current.followersGained += row.followers_gained; current.leads += row.leads; seriesMap.set(date, current); }
  const platformMap = new Map<string, { platform: string; views: number; interactions: number; contentCount: number }>();
  for (const row of latestRows) { const current = platformMap.get(row.platform) || { platform: row.platform, views: 0, interactions: 0, contentCount: 0 }; current.views += row.views; current.interactions += interactions(row); current.contentCount += 1; platformMap.set(row.platform, current); }
  const platforms = Array.from(platformMap.values()).map((item) => ({ ...item, engagementRate: safeRate(item.interactions, item.views) })).sort((a, b) => b.views - a.views);
  const topContent = latestRows.map((row) => ({ publicationId: row.publication_id, contentItemId: row.content_item_id, title: row.title, platform: row.platform, genre: row.genre || null, reviewStatus: row.review_status || null, externalUrl: row.external_url, publishedAt: row.published_at, observedAt: row.observed_at, views: row.views, interactions: interactions(row), engagementRate: safeRate(interactions(row), row.views), followersGained: row.followers_gained, homepageVisits: row.homepage_visits || 0, leads: row.leads })).sort((a, b) => b.views - a.views || b.interactions - a.interactions).slice(0, 10);
  return { periodStart, periodEnd, summary, series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)), platforms, topContent };
}

export async function loadPerformanceAnalytics(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const rows = await db.prepare(`
    SELECT * FROM (
      SELECT m.publication_id, m.content_item_id, c.title, p.platform, p.external_url, p.published_at, m.observed_at,
        NULL AS genre, NULL AS review_status, m.views, m.likes, m.comments, m.shares, m.saves, m.followers_gained, m.leads, NULL AS homepage_visits, m.average_watch_seconds, m.completion_rate_bps, NULL AS five_second_completion_rate_bps, NULL AS cover_ctr_bps, NULL AS two_second_bounce_rate_bps
      FROM publication_metric_snapshots m
      INNER JOIN publication_records p ON p.id = m.publication_id AND p.organization_id = m.organization_id AND p.project_id = m.project_id
      INNER JOIN content_items c ON c.id = m.content_item_id AND c.organization_id = m.organization_id AND c.project_id = m.project_id
      LEFT JOIN performance_import_batches b ON b.id = m.import_batch_id AND b.organization_id = m.organization_id AND b.project_id = m.project_id
      WHERE m.organization_id = ? AND m.project_id = ? AND (m.import_batch_id IS NULL OR b.status = 'completed') AND substr(m.observed_at, 1, 10) BETWEEN ? AND ?
      UNION ALL
      SELECT w.id AS publication_id, COALESCE(w.content_item_id, '') AS content_item_id, w.title, s.platform, NULL AS external_url, w.published_at, s.as_of_at AS observed_at,
        w.genre, w.review_status, s.views, s.likes, s.comments, s.shares, s.saves, s.follower_delta AS followers_gained, 0 AS leads, s.homepage_visits, CAST(s.avg_watch_ms / 1000 AS INTEGER) AS average_watch_seconds, s.completion_rate_bps, s.five_second_completion_rate_bps, s.cover_ctr_bps, s.two_second_bounce_rate_bps
      FROM platform_metric_snapshots s
      INNER JOIN platform_works w ON w.id = s.work_id AND w.organization_id = s.organization_id AND w.project_id = s.project_id
      INNER JOIN platform_metric_import_batches b ON b.id = s.import_batch_id AND b.organization_id = s.organization_id AND b.project_id = s.project_id AND b.status = 'completed'
      WHERE s.organization_id = ? AND s.project_id = ? AND substr(s.as_of_at, 1, 10) BETWEEN ? AND ?
    ) ORDER BY observed_at ASC LIMIT 10000
  `).bind(organizationId, projectId, periodStart, periodEnd, organizationId, projectId, periodStart, periodEnd).all<MetricSnapshotRow>();
  return buildAnalyticsSnapshot(rows.results, periodStart, periodEnd);
}

export function buildReportNarrative(snapshot: AnalyticsSnapshot) {
  const { summary, topContent } = snapshot;
  if (!summary.contentCount) return { summary: "本报告周期内尚未导入已发布内容的数据快照。", highlights: ["当前没有可计算的内容表现数据。"], recommendations: ["从发布管理下载模板并导入至少一条作品快照。", "统一在固定时间记录累计播放和互动数据，保证周期可比。"] };
  const best = topContent[0]; const engagement = (summary.engagementRate * 100).toFixed(2);
  return {
    summary: `本周期纳入 ${summary.contentCount} 条已发布内容，累计播放 ${summary.views.toLocaleString("zh-CN")}，总互动率 ${engagement}%，新增线索 ${summary.leads.toLocaleString("zh-CN")}。`,
    highlights: [best ? `播放最高内容《${best.title}》获得 ${best.views.toLocaleString("zh-CN")} 次播放。` : "暂无头部内容。", `累计带来 ${summary.followersGained.toLocaleString("zh-CN")} 个新增关注。`, `收藏、评论、分享与点赞合计 ${summary.interactions.toLocaleString("zh-CN")} 次。`],
    recommendations: [summary.engagementRate < 0.03 ? "当前总互动率低于 3%，优先复盘开头承诺、互动提问和内容受众匹配。" : "互动率表现稳定，继续复用高互动内容的选题角度与开头结构。", summary.leads === 0 ? "尚未记录线索，建议统一转化动作并在下一周期补录线索数据。" : "已有线索反馈，下一周期按内容主题拆分线索贡献。", best ? `将《${best.title}》的结构沉淀回知识库和选题模板。` : "持续积累可比较的数据快照。"],
  };
}
