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
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0 });
  const completionRows = latestRows.filter((row) => row.completion_rate_bps !== null);
  const watchRows = latestRows.filter((row) => row.average_watch_seconds !== null);
  const summary = {
    ...totals,
    contentCount: latestRows.length,
    engagementRate: safeRate(totals.interactions, totals.views),
    leadRate: safeRate(totals.leads, totals.views),
    averageCompletionRate: completionRows.length ? completionRows.reduce((sum, row) => sum + (row.completion_rate_bps || 0), 0) / completionRows.length / 100 : null,
    averageWatchSeconds: watchRows.length ? watchRows.reduce((sum, row) => sum + (row.average_watch_seconds || 0), 0) / watchRows.length : null,
  };
  const seriesMap = new Map<string, { date: string; views: number; interactions: number; followersGained: number; leads: number }>();
  for (const row of daily.values()) { const date = row.observed_at.slice(0, 10); const current = seriesMap.get(date) || { date, views: 0, interactions: 0, followersGained: 0, leads: 0 }; current.views += row.views; current.interactions += interactions(row); current.followersGained += row.followers_gained; current.leads += row.leads; seriesMap.set(date, current); }
  const platformMap = new Map<string, { platform: string; views: number; interactions: number; contentCount: number }>();
  for (const row of latestRows) { const current = platformMap.get(row.platform) || { platform: row.platform, views: 0, interactions: 0, contentCount: 0 }; current.views += row.views; current.interactions += interactions(row); current.contentCount += 1; platformMap.set(row.platform, current); }
  const platforms = Array.from(platformMap.values()).map((item) => ({ ...item, engagementRate: safeRate(item.interactions, item.views) })).sort((a, b) => b.views - a.views);
  const topContent = latestRows.map((row) => ({ publicationId: row.publication_id, contentItemId: row.content_item_id, title: row.title, platform: row.platform, externalUrl: row.external_url, publishedAt: row.published_at, observedAt: row.observed_at, views: row.views, interactions: interactions(row), engagementRate: safeRate(interactions(row), row.views), followersGained: row.followers_gained, leads: row.leads })).sort((a, b) => b.views - a.views || b.interactions - a.interactions).slice(0, 10);
  return { periodStart, periodEnd, summary, series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)), platforms, topContent };
}

export async function loadPerformanceAnalytics(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const rows = await db.prepare(`
    SELECT m.publication_id, m.content_item_id, c.title, p.platform, p.external_url, p.published_at, m.observed_at,
      m.views, m.likes, m.comments, m.shares, m.saves, m.followers_gained, m.leads, m.average_watch_seconds, m.completion_rate_bps
    FROM publication_metric_snapshots m
    INNER JOIN publication_records p ON p.id = m.publication_id AND p.organization_id = m.organization_id AND p.project_id = m.project_id
    INNER JOIN content_items c ON c.id = m.content_item_id AND c.organization_id = m.organization_id AND c.project_id = m.project_id
    LEFT JOIN performance_import_batches b ON b.id = m.import_batch_id AND b.organization_id = m.organization_id AND b.project_id = m.project_id
    WHERE m.organization_id = ? AND m.project_id = ? AND (m.import_batch_id IS NULL OR b.status = 'completed') AND substr(m.observed_at, 1, 10) BETWEEN ? AND ?
    ORDER BY m.observed_at ASC LIMIT 10000
  `).bind(organizationId, projectId, periodStart, periodEnd).all<MetricSnapshotRow>();
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
