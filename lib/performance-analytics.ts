import { z } from "zod";
import type { getD1 } from "../db/runtime";

const identifier = z.string().trim().min(1).max(200);
const nonNegativeInteger = z.coerce.number().int().min(0).max(2_147_483_647);

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
  views: number; likes: number; comments: number; shares: number; saves: number; followers_gained: number; leads: number; average_watch_seconds: number | null; completion_rate_bps: number | null;
};

export type AnalyticsSnapshot = ReturnType<typeof buildAnalyticsSnapshot>;

function safeRate(numerator: number, denominator: number) { return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0; }
function interactions(row: MetricSnapshotRow) { return row.likes + row.comments + row.shares + row.saves; }
function safeDelta(current: number, baseline: number) { return Math.max(0, current - baseline); }
function isInPeriod(row: MetricSnapshotRow, periodStart: string, periodEnd: string) { const date = row.observed_at.slice(0, 10); return date >= periodStart && date <= periodEnd; }
function zeroMetricRow(row: MetricSnapshotRow): MetricSnapshotRow { return { ...row, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0 }; }
function metricDelta(current: MetricSnapshotRow, baseline: MetricSnapshotRow) {
  return {
    views: safeDelta(current.views, baseline.views),
    interactions: safeDelta(interactions(current), interactions(baseline)),
    followersGained: safeDelta(current.followers_gained, baseline.followers_gained),
    leads: safeDelta(current.leads, baseline.leads),
  };
}
function previousPeriod(periodStart: string, periodEnd: string) {
  const start = new Date(`${periodStart}T00:00:00.000Z`); const end = new Date(`${periodEnd}T00:00:00.000Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const previousEnd = new Date(start); previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd); previousStart.setUTCDate(previousStart.getUTCDate() - days + 1);
  return { periodStart: previousStart.toISOString().slice(0, 10), periodEnd: previousEnd.toISOString().slice(0, 10) };
}
function changeRate(current: number, previous: number) { return previous > 0 ? Math.round(((current - previous) / previous) * 10_000) / 10_000 : null; }

export function buildAnalyticsSnapshot(rows: MetricSnapshotRow[], periodStart: string, periodEnd: string, comparison: null | { periodStart: string; periodEnd: string; summary: { views: number; interactions: number; followersGained: number; leads: number } } = null) {
  const byPublication = new Map<string, MetricSnapshotRow[]>();
  for (const row of rows) { const list = byPublication.get(row.publication_id) || []; list.push(row); byPublication.set(row.publication_id, list); }
  const profiles = Array.from(byPublication.values()).flatMap((publicationRows) => {
    const sorted = publicationRows.slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const periodRows = sorted.filter((row) => isInPeriod(row, periodStart, periodEnd));
    if (!periodRows.length) return [];
    const latest = periodRows[periodRows.length - 1];
    const before = sorted.filter((row) => row.observed_at.slice(0, 10) < periodStart).at(-1) ?? null;
    const isNewPublication = Boolean(latest.published_at && latest.published_at.slice(0, 10) >= periodStart && latest.published_at.slice(0, 10) <= periodEnd);
    const baseline = before ?? (isNewPublication ? zeroMetricRow(latest) : periodRows[0]);
    return [{ latest, periodRows, baseline, baselineMode: before ? "prior_snapshot" as const : isNewPublication ? "new_publication" as const : "first_period_snapshot" as const, delta: metricDelta(latest, baseline) }];
  });
  const totals = profiles.reduce((sum, profile) => ({
    views: sum.views + profile.delta.views,
    interactions: sum.interactions + profile.delta.interactions,
    followersGained: sum.followersGained + profile.delta.followersGained,
    leads: sum.leads + profile.delta.leads,
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0 });
  const cumulative = profiles.reduce((sum, profile) => ({
    views: sum.views + profile.latest.views,
    interactions: sum.interactions + interactions(profile.latest),
    followersGained: sum.followersGained + profile.latest.followers_gained,
    leads: sum.leads + profile.latest.leads,
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0 });
  const latestRows = profiles.map((profile) => profile.latest);
  const completionRows = latestRows.filter((row) => row.completion_rate_bps !== null); const watchRows = latestRows.filter((row) => row.average_watch_seconds !== null);
  const baselineCoverage = { total: profiles.length, complete: profiles.filter((profile) => profile.baselineMode !== "first_period_snapshot").length, partial: profiles.filter((profile) => profile.baselineMode === "first_period_snapshot").length, newPublications: profiles.filter((profile) => profile.baselineMode === "new_publication").length };
  const summary = {
    ...totals,
    contentCount: profiles.length,
    cumulativeViews: cumulative.views,
    cumulativeInteractions: cumulative.interactions,
    cumulativeFollowersGained: cumulative.followersGained,
    cumulativeLeads: cumulative.leads,
    engagementRate: safeRate(totals.interactions, totals.views),
    leadRate: safeRate(totals.leads, totals.views),
    averageCompletionRate: completionRows.length ? completionRows.reduce((sum, row) => sum + (row.completion_rate_bps || 0), 0) / completionRows.length / 100 : null,
    averageWatchSeconds: watchRows.length ? watchRows.reduce((sum, row) => sum + (row.average_watch_seconds || 0), 0) / watchRows.length : null,
    baselineCoverage,
  };
  const seriesMap = new Map<string, { date: string; views: number; interactions: number; followersGained: number; leads: number }>();
  for (const profile of profiles) {
    const daily = new Map<string, MetricSnapshotRow>();
    for (const row of profile.periodRows) { const date = row.observed_at.slice(0, 10); const current = daily.get(date); if (!current || row.observed_at > current.observed_at) daily.set(date, row); }
    let previous = profile.baseline;
    for (const [date, row] of Array.from(daily.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      const delta = metricDelta(row, previous); const current = seriesMap.get(date) || { date, views: 0, interactions: 0, followersGained: 0, leads: 0 };
      current.views += delta.views; current.interactions += delta.interactions; current.followersGained += delta.followersGained; current.leads += delta.leads; seriesMap.set(date, current); previous = row;
    }
  }
  const platformMap = new Map<string, { platform: string; views: number; interactions: number; contentCount: number }>();
  for (const profile of profiles) { const current = platformMap.get(profile.latest.platform) || { platform: profile.latest.platform, views: 0, interactions: 0, contentCount: 0 }; current.views += profile.delta.views; current.interactions += profile.delta.interactions; current.contentCount += 1; platformMap.set(profile.latest.platform, current); }
  const platforms = Array.from(platformMap.values()).map((item) => ({ ...item, engagementRate: safeRate(item.interactions, item.views) })).sort((a, b) => b.views - a.views);
  const topContent = profiles.map((profile) => ({ publicationId: profile.latest.publication_id, contentItemId: profile.latest.content_item_id, title: profile.latest.title, platform: profile.latest.platform, externalUrl: profile.latest.external_url, publishedAt: profile.latest.published_at, observedAt: profile.latest.observed_at, views: profile.delta.views, cumulativeViews: profile.latest.views, interactions: profile.delta.interactions, cumulativeInteractions: interactions(profile.latest), engagementRate: safeRate(profile.delta.interactions, profile.delta.views), followersGained: profile.delta.followersGained, leads: profile.delta.leads, baselineMode: profile.baselineMode })).sort((a, b) => b.views - a.views || b.interactions - a.interactions).slice(0, 10);
  const comparisonSummary = comparison ? { periodStart: comparison.periodStart, periodEnd: comparison.periodEnd, previous: comparison.summary, changeRate: { views: changeRate(summary.views, comparison.summary.views), interactions: changeRate(summary.interactions, comparison.summary.interactions), followersGained: changeRate(summary.followersGained, comparison.summary.followersGained), leads: changeRate(summary.leads, comparison.summary.leads) } } : null;
  return { periodStart, periodEnd, summary, comparison: comparisonSummary, series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)), platforms, topContent };
}

async function loadPerformancePeriodRows(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const rows = await db.prepare(`
    SELECT m.publication_id, m.content_item_id, c.title, p.platform, p.external_url, p.published_at, m.observed_at,
      m.views, m.likes, m.comments, m.shares, m.saves, m.followers_gained, m.leads, m.average_watch_seconds, m.completion_rate_bps
    FROM publication_metric_snapshots m
    INNER JOIN publication_records p ON p.id = m.publication_id AND p.organization_id = m.organization_id AND p.project_id = m.project_id
    INNER JOIN content_items c ON c.id = m.content_item_id AND c.organization_id = m.organization_id AND c.project_id = m.project_id
    LEFT JOIN performance_import_batches b ON b.id = m.import_batch_id AND b.organization_id = m.organization_id AND b.project_id = m.project_id
    WHERE m.organization_id = ? AND m.project_id = ? AND (m.import_batch_id IS NULL OR b.status = 'completed') AND (
      substr(m.observed_at, 1, 10) BETWEEN ? AND ? OR (
        substr(m.observed_at, 1, 10) < ? AND m.observed_at = (
          SELECT MAX(previous.observed_at) FROM publication_metric_snapshots previous
          LEFT JOIN performance_import_batches previous_batch ON previous_batch.id = previous.import_batch_id AND previous_batch.organization_id = previous.organization_id AND previous_batch.project_id = previous.project_id
          WHERE previous.organization_id = m.organization_id AND previous.project_id = m.project_id AND previous.publication_id = m.publication_id
            AND (previous.import_batch_id IS NULL OR previous_batch.status = 'completed') AND substr(previous.observed_at, 1, 10) < ?
        )
      )
    )
    ORDER BY m.observed_at ASC LIMIT 10000
  `).bind(organizationId, projectId, periodStart, periodEnd, periodStart, periodStart).all<MetricSnapshotRow>();
  return rows.results;
}

export async function loadPerformanceAnalytics(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const previous = previousPeriod(periodStart, periodEnd);
  const [currentRows, previousRows] = await Promise.all([
    loadPerformancePeriodRows(db, organizationId, projectId, periodStart, periodEnd),
    loadPerformancePeriodRows(db, organizationId, projectId, previous.periodStart, previous.periodEnd),
  ]);
  const previousSnapshot = buildAnalyticsSnapshot(previousRows, previous.periodStart, previous.periodEnd);
  return buildAnalyticsSnapshot(currentRows, periodStart, periodEnd, { periodStart: previous.periodStart, periodEnd: previous.periodEnd, summary: previousSnapshot.summary });
}

export function buildReportNarrative(snapshot: AnalyticsSnapshot) {
  const { summary, topContent } = snapshot;
  if (!summary.contentCount) return { summary: "本报告周期内尚未导入已发布内容的数据快照。", highlights: ["当前没有可计算的内容表现数据。"], recommendations: ["从发布管理下载模板并导入至少一条作品快照。", "统一在固定时间记录累计播放和互动数据，保证周期可比。"] };
  const best = topContent[0]; const engagement = (summary.engagementRate * 100).toFixed(2); const qualifier = summary.baselineCoverage.partial ? "可确认" : "";
  const coverageNote = summary.baselineCoverage.partial ? `其中 ${summary.baselineCoverage.partial} 条历史作品缺少期初快照，增量从本期首条快照起计算。` : "全部纳入作品均有期初快照，或为本期新发布作品。";
  const viewsChange = snapshot.comparison?.changeRate.views;
  const comparisonHighlight = viewsChange === null || viewsChange === undefined ? "前一周期没有可比较的新增播放数据。" : `新增播放较前一周期${viewsChange >= 0 ? "增长" : "下降"} ${Math.abs(viewsChange * 100).toFixed(1)}%。`;
  return {
    summary: `本周期纳入 ${summary.contentCount} 条已发布内容，${qualifier}新增播放 ${summary.views.toLocaleString("zh-CN")}，周期互动率 ${engagement}%，${qualifier}新增线索 ${summary.leads.toLocaleString("zh-CN")}。${coverageNote}`,
    highlights: [best ? `周期新增播放最高内容《${best.title}》获得 ${best.views.toLocaleString("zh-CN")} 次新增播放。` : "暂无头部内容。", comparisonHighlight, `${qualifier}新增关注 ${summary.followersGained.toLocaleString("zh-CN")} 个。`, `本周期新增点赞、评论、分享与收藏合计 ${summary.interactions.toLocaleString("zh-CN")} 次。`],
    recommendations: [summary.engagementRate < 0.03 ? "当前总互动率低于 3%，优先复盘开头承诺、互动提问和内容受众匹配。" : "互动率表现稳定，继续复用高互动内容的选题角度与开头结构。", summary.leads === 0 ? "尚未记录线索，建议统一转化动作并在下一周期补录线索数据。" : "已有线索反馈，下一周期按内容主题拆分线索贡献。", best ? `将《${best.title}》的结构沉淀回知识库和选题模板。` : "持续积累可比较的数据快照。"],
  };
}
