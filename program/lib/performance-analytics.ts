import { publicPlatformWorkSql } from "./performance-visibility.ts";
import { z } from "zod";
import type { getD1 } from "../db/runtime";
import { buildPerformanceDiagnostics } from "./performance-diagnostics.ts";
import { metricUtc, metricTimeKey, metricUtcSql } from "./metric-time.ts";

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
  source: z.enum(["csv", "xlsx", "manual"]),
  filename: z.string().trim().max(300).optional(),
  rows: z.array(performanceRowSchema).min(1).max(500),
}).strict();

export const douyinMetricRowSchema = z.object({
  platformWorkId: identifier.optional(),
  title: z.string().trim().min(1).max(2_000),
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
  source: z.enum(["csv", "xlsx", "manual"]),
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

export const finalizeReportSchema = z.object({ organizationId: identifier, projectId: identifier, expectedUpdatedAt: z.string().min(1).max(100) }).strict();

export type MetricSnapshotRow = {
  metric_id?: string; metric_created_at?: string;
  timestamp_aliases?: number; timestamp_conflicts?: number;
  publication_id: string; content_item_id: string; title: string; platform: string; external_url: string | null; published_at: string | null; observed_at: string;
  video_id?: string | null; video_title?: string | null; video_duration_sec?: number | null;
  genre?: string | null; review_status?: string | null; views: number; likes: number; comments: number; shares: number; saves: number; followers_gained: number; leads: number; homepage_visits?: number; average_watch_seconds: number | null; completion_rate_bps: number | null; five_second_completion_rate_bps?: number | null; cover_ctr_bps?: number | null; two_second_bounce_rate_bps?: number | null;
};

export type AnalyticsSnapshot = ReturnType<typeof buildAnalyticsSnapshot>;
export type PerformanceEvidenceRef = {
  kind: "video_segment" | "script_structure" | "material";
  contentItemId: string;
  sourceType: string;
  sourceId: string;
  label: string;
  quote: string | null;
  locator: string | null;
};

export type ContentEvidenceRow = {
  content_item_id: string;
  content_version_id: string;
  version: number;
  pack_json: string;
  citation_type: string;
  citation_id: string;
  quote: string | null;
  source_title?: string | null;
  source_locator_json?: string | null;
};

function safeRate(numerator: number, denominator: number) { return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0; }
function interactions(row: MetricSnapshotRow) { return row.likes + row.comments + row.shares + row.saves; }
function percentile(values: number[], fraction: number) { if (!values.length) return null; const sorted = values.slice().sort((a, b) => a - b); const index = (sorted.length - 1) * fraction; const lower = Math.floor(index); const upper = Math.ceil(index); return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower); }
function distribution(values: Array<number | null>) { const valid = values.filter((value): value is number => typeof value === "number"); return { count: valid.length, p25: percentile(valid, 0.25), median: percentile(valid, 0.5), p75: percentile(valid, 0.75), simpleMean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null }; }
function safeDelta(current: number, baseline: number) { return Math.max(0, current - baseline); }
function isInPeriod(row: MetricSnapshotRow, periodStart: string, periodEnd: string) { const date = row.observed_at.slice(0, 10); return date >= periodStart && date <= periodEnd; }
function zeroMetricRow(row: MetricSnapshotRow): MetricSnapshotRow { return { ...row, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0, homepage_visits: 0 }; }
function metricDelta(current: MetricSnapshotRow, baseline: MetricSnapshotRow) {
  return {
    views: safeDelta(current.views, baseline.views),
    interactions: safeDelta(interactions(current), interactions(baseline)),
    // Douyin reports follower change as a signed metric. Preserve decreases instead
    // of silently turning an unfollow period into zero growth.
    followersGained: current.followers_gained - baseline.followers_gained,
    leads: safeDelta(current.leads, baseline.leads),
    homepageVisits: safeDelta(current.homepage_visits || 0, baseline.homepage_visits || 0),
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
function parseEvidenceLocator(value: string | null | undefined) {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

export function buildPerformanceEvidence(rows: ContentEvidenceRow[]): PerformanceEvidenceRef[] {
  const result: PerformanceEvidenceRef[] = [];
  const seen = new Set<string>();
  const scriptVersions = new Set<string>();
  for (const row of rows) {
    if (!scriptVersions.has(row.content_version_id)) {
      scriptVersions.add(row.content_version_id);
      try {
        const pack = JSON.parse(row.pack_json) as { storyboard?: unknown };
        const storyboard = Array.isArray(pack.storyboard) ? pack.storyboard : [];
        storyboard.slice(0, 3).forEach((shot, index) => {
          if (!shot || typeof shot !== "object") return;
          const value = shot as Record<string, unknown>;
          const script = typeof value.script === "string" ? value.script.trim() : "";
          const shotName = typeof value.shot === "string" ? value.shot.trim() : "镜头 " + (index + 1);
          if (!script) return;
          result.push({
            kind: "script_structure",
            contentItemId: row.content_item_id,
            sourceType: "content_version",
            sourceId: row.content_version_id + ":storyboard:" + index,
            label: "脚本结构：" + shotName,
            quote: script.slice(0, 240),
            locator: "storyboard[" + index + "]",
          });
        });
      } catch {
        // A historical hand-written version may have no structured production pack.
      }
    }
    const key = row.content_item_id + ":" + row.citation_type + ":" + row.citation_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const isVideo = row.citation_type === "video_atom" || row.citation_type === "video_analysis";
    result.push({
      kind: isVideo ? "video_segment" : "material",
      contentItemId: row.content_item_id,
      sourceType: row.citation_type,
      sourceId: row.citation_id,
      label: (isVideo ? "视频证据：" : "素材证据：") + (row.source_title || row.citation_type),
      quote: row.quote || null,
      locator: row.source_locator_json ? parseEvidenceLocator(row.source_locator_json) : null,
    });
  }
  return result.slice(0, 240);
}
function buildPeerGroups(rows: MetricSnapshotRow[], periodStart: string, periodEnd: string) {
  const groups = new Map<string, MetricSnapshotRow[]>();
  for (const row of rows) {
    const key = row.genre?.trim() || "未分类";
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return Array.from(groups.entries()).map(([key, group]) => ({
    key,
    label: key,
    sampleSize: group.length,
    medianViews: percentile(group.map((row) => row.views), 0.5),
    medianCompletionRate: (() => { const values = group.map((row) => row.completion_rate_bps === null || row.completion_rate_bps === undefined ? null : row.completion_rate_bps / 100).filter((value): value is number => value !== null); return values.length ? percentile(values, 0.5) : null; })(),
    medianEngagementRate: percentile(group.map((row) => safeRate(interactions(row), row.views)), 0.5),
    periodStart,
    periodEnd,
  })).sort((left, right) => right.sampleSize - left.sampleSize || left.label.localeCompare(right.label)).slice(0, 20);
}

export function buildAnalyticsSnapshot(rows: MetricSnapshotRow[], periodStart: string, periodEnd: string, comparison: null | { periodStart: string; periodEnd: string; summary: { views: number; interactions: number; followersGained: number; leads: number } } = null) {
  const byPublication = new Map<string, MetricSnapshotRow[]>();
  const instants = new Map<string, MetricSnapshotRow>(); let timestampAliases = 0, timestampConflicts = 0;
  for (const raw of rows.slice().sort((a,b)=>(a.metric_created_at||"").localeCompare(b.metric_created_at||"") || (a.metric_id||"").localeCompare(b.metric_id||""))) {
    timestampAliases += raw.timestamp_aliases || 0; timestampConflicts += raw.timestamp_conflicts || 0;
    const row = { ...raw, observed_at: metricUtc(raw.observed_at) || raw.observed_at, published_at: metricUtc(raw.published_at) };
    const key=JSON.stringify([row.publication_id,row.observed_at]), prior=instants.get(key);
    if (prior) { timestampAliases++; if (["views","likes","comments","shares","saves","followers_gained","leads","homepage_visits","average_watch_seconds","completion_rate_bps","five_second_completion_rate_bps","cover_ctr_bps","two_second_bounce_rate_bps"].some(field=>prior[field as keyof MetricSnapshotRow]!==row[field as keyof MetricSnapshotRow])) timestampConflicts++; continue; }
    instants.set(key,row);
    const list = byPublication.get(row.publication_id) || []; list.push(row); byPublication.set(row.publication_id, list);
  }
  const profiles = Array.from(byPublication.values()).flatMap((publicationRows) => {
    const sorted = publicationRows.slice().sort((a, b) => metricTimeKey(a.observed_at).localeCompare(metricTimeKey(b.observed_at)));
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
    homepageVisits: sum.homepageVisits + profile.delta.homepageVisits,
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0, homepageVisits: 0 });
  const cumulative = profiles.reduce((sum, profile) => ({
    views: sum.views + profile.latest.views,
    interactions: sum.interactions + interactions(profile.latest),
    followersGained: sum.followersGained + profile.latest.followers_gained,
    leads: sum.leads + profile.latest.leads,
    homepageVisits: sum.homepageVisits + (profile.latest.homepage_visits || 0),
  }), { views: 0, interactions: 0, followersGained: 0, leads: 0, homepageVisits: 0 });
  const latestRows = profiles.map((profile) => profile.latest);
  const completionRows = latestRows.filter((row) => row.completion_rate_bps !== null); const watchRows = latestRows.filter((row) => row.average_watch_seconds !== null);
  const baselineCoverage = { total: profiles.length, complete: profiles.filter((profile) => profile.baselineMode !== "first_period_snapshot").length, partial: profiles.filter((profile) => profile.baselineMode === "first_period_snapshot").length, newPublications: profiles.filter((profile) => profile.baselineMode === "new_publication").length };
  const summary = {
    timestampAliases, timestampConflicts,
    ...totals,
    contentCount: profiles.length,
    cumulativeViews: cumulative.views,
    cumulativeInteractions: cumulative.interactions,
    cumulativeFollowersGained: cumulative.followersGained,
    cumulativeLeads: cumulative.leads,
    homepageVisits: totals.homepageVisits,
    cumulativeHomepageVisits: cumulative.homepageVisits,
    engagementRate: safeRate(totals.interactions, totals.views),
    leadRate: safeRate(totals.leads, totals.views),
    homepageVisitRate: safeRate(totals.homepageVisits, totals.views),
    playToFollowerRate: safeRate(totals.followersGained, totals.views),
    homepageToFollowerRate: safeRate(totals.followersGained, totals.homepageVisits),
    averageCompletionRate: completionRows.length ? completionRows.reduce((sum, row) => sum + (row.completion_rate_bps || 0), 0) / completionRows.length / 100 : null,
    averageWatchSeconds: watchRows.length ? watchRows.reduce((sum, row) => sum + (row.average_watch_seconds || 0), 0) / watchRows.length : null,
    weightedAverageWatchSeconds: (() => { const weighted = latestRows.filter((row) => row.average_watch_seconds !== null && row.views > 0); const views = weighted.reduce((sum, row) => sum + row.views, 0); return views ? weighted.reduce((sum, row) => sum + (row.average_watch_seconds || 0) * row.views, 0) / views : null; })(),
    completionRateDistribution: distribution(latestRows.map((row) => row.completion_rate_bps === null ? null : row.completion_rate_bps / 100)),
    fiveSecondCompletionRateDistribution: distribution(latestRows.map((row) => row.five_second_completion_rate_bps === null || row.five_second_completion_rate_bps === undefined ? null : row.five_second_completion_rate_bps / 100)),
    coverCtrDistribution: distribution(latestRows.map((row) => row.cover_ctr_bps === null || row.cover_ctr_bps === undefined ? null : row.cover_ctr_bps / 100)),
    twoSecondBounceRateDistribution: distribution(latestRows.map((row) => row.two_second_bounce_rate_bps === null || row.two_second_bounce_rate_bps === undefined ? null : row.two_second_bounce_rate_bps / 100)),
    funnel: ["coverClick", "twoSecondRetention", "fiveSecondRetention", "completion", "interaction", "homepageVisit", "follow"].map((stage) => ({ stage, note: "按作品快照分布展示；比率不求和" })),
    baselineCoverage,
  };
  const seriesMap = new Map<string, { date: string; views: number; interactions: number; followersGained: number; leads: number }>();
  for (const profile of profiles) {
    const daily = new Map<string, MetricSnapshotRow>();
    for (const row of profile.periodRows) { const date = row.observed_at.slice(0, 10); const current = daily.get(date); if (!current || metricTimeKey(row.observed_at) > metricTimeKey(current.observed_at)) daily.set(date, row); }
    let previous = profile.baseline;
    for (const [date, row] of Array.from(daily.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      const delta = metricDelta(row, previous); const current = seriesMap.get(date) || { date, views: 0, interactions: 0, followersGained: 0, leads: 0 };
      current.views += delta.views; current.interactions += delta.interactions; current.followersGained += delta.followersGained; current.leads += delta.leads; seriesMap.set(date, current); previous = row;
    }
  }
  const platformMap = new Map<string, { platform: string; views: number; interactions: number; contentCount: number }>();
  for (const profile of profiles) { const current = platformMap.get(profile.latest.platform) || { platform: profile.latest.platform, views: 0, interactions: 0, contentCount: 0 }; current.views += profile.delta.views; current.interactions += profile.delta.interactions; current.contentCount += 1; platformMap.set(profile.latest.platform, current); }
  const platforms = Array.from(platformMap.values()).map((item) => ({ ...item, engagementRate: safeRate(item.interactions, item.views) })).sort((a, b) => b.views - a.views);
  const contentPerformance = profiles.map((profile) => ({
    publicationId: profile.latest.publication_id, title: profile.latest.title, platform: profile.latest.platform,
    externalUrl: profile.latest.external_url, publishedAt: profile.latest.published_at,
    videoId: profile.latest.video_id || null, videoTitle: profile.latest.video_title || null, videoDurationSec: profile.latest.video_duration_sec ?? null,
    views: profile.latest.views,
    interactions: interactions(profile.latest), engagementRate: safeRate(interactions(profile.latest), profile.latest.views),
    followersGained: profile.latest.followers_gained, leads: profile.latest.leads,
  })).sort((a, b) => b.views - a.views || b.interactions - a.interactions);
  const publishedSeriesMap = new Map<string, { date: string; views: number; interactions: number; contentCount: number }>();
  for (const item of contentPerformance) {
    const date = item.publishedAt?.slice(0, 10);
    if (!date || date < periodStart || date > periodEnd) continue;
    const current = publishedSeriesMap.get(date) || { date, views: 0, interactions: 0, contentCount: 0 };
    current.views += item.views; current.interactions += item.interactions; current.contentCount += 1;
    publishedSeriesMap.set(date, current);
  }
  const publishedSeries = Array.from(publishedSeriesMap.values()).sort((left, right) => left.date.localeCompare(right.date));
  const topContent = profiles.map((profile) => ({ publicationId: profile.latest.publication_id, contentItemId: profile.latest.content_item_id, title: profile.latest.title, platform: profile.latest.platform, genre: profile.latest.genre || null, reviewStatus: profile.latest.review_status || null, externalUrl: profile.latest.external_url, publishedAt: profile.latest.published_at, observedAt: profile.latest.observed_at, views: profile.delta.views, cumulativeViews: profile.latest.views, interactions: profile.delta.interactions, cumulativeInteractions: interactions(profile.latest), engagementRate: safeRate(profile.delta.interactions, profile.delta.views), followersGained: profile.delta.followersGained, homepageVisits: profile.delta.homepageVisits, cumulativeHomepageVisits: profile.latest.homepage_visits || 0, leads: profile.delta.leads, baselineMode: profile.baselineMode })).sort((a, b) => b.views - a.views || b.interactions - a.interactions).slice(0, 10);
  const comparisonSummary = comparison ? { periodStart: comparison.periodStart, periodEnd: comparison.periodEnd, previous: comparison.summary, changeRate: { views: changeRate(summary.views, comparison.summary.views), interactions: changeRate(summary.interactions, comparison.summary.interactions), followersGained: changeRate(summary.followersGained, comparison.summary.followersGained), leads: changeRate(summary.leads, comparison.summary.leads) } } : null;
  const peerGroups = buildPeerGroups(latestRows, periodStart, periodEnd);
  const snapshot = { periodStart, periodEnd, summary, comparison: comparisonSummary, series: Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date)), publishedSeries, platforms, contentPerformance, topContent, peerGroups, evidence: [] as PerformanceEvidenceRef[] };
  return { ...snapshot, diagnostics: buildPerformanceDiagnostics(snapshot) };
}

async function loadPerformancePeriodRows(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const metricValues = "json_array(views,likes,comments,shares,saves,followers_gained,leads,homepage_visits,average_watch_seconds,completion_rate_bps,five_second_completion_rate_bps,cover_ctr_bps,two_second_bounce_rate_bps)";
  const rows = await db.prepare(`
    WITH combined AS (
      SELECT m.id AS metric_id, m.created_at AS metric_created_at, m.publication_id, m.content_item_id, c.title, p.platform, p.external_url, ${metricUtcSql("p.published_at")} AS published_at, ${metricUtcSql("m.observed_at")} AS observed_at,
        NULL AS video_id, NULL AS video_title, NULL AS video_duration_sec,
        NULL AS genre, NULL AS review_status, m.views, m.likes, m.comments, m.shares, m.saves, m.followers_gained, m.leads,
        0 AS homepage_visits, m.average_watch_seconds, m.completion_rate_bps,
        NULL AS five_second_completion_rate_bps, NULL AS cover_ctr_bps, NULL AS two_second_bounce_rate_bps
      FROM publication_metric_snapshots m
      INNER JOIN publication_records p ON p.id = m.publication_id AND p.organization_id = m.organization_id AND p.project_id = m.project_id
      INNER JOIN content_items c ON c.id = m.content_item_id AND c.organization_id = m.organization_id AND c.project_id = m.project_id
      LEFT JOIN performance_import_batches b ON b.id = m.import_batch_id AND b.organization_id = m.organization_id AND b.project_id = m.project_id
      WHERE m.organization_id = ? AND m.project_id = ? AND p.status='published' AND (m.import_batch_id IS NULL OR b.status = 'completed')
      UNION ALL
      SELECT s.id AS metric_id, s.created_at AS metric_created_at, 'platform:' || w.id AS publication_id, COALESCE(w.content_item_id, '') AS content_item_id, w.title, s.platform,
        v.source_url AS external_url, ${metricUtcSql("w.published_at")} AS published_at, ${metricUtcSql("s.as_of_at")} AS observed_at,
        w.video_id AS video_id, v.title AS video_title, v.duration_sec AS video_duration_sec, w.genre, w.review_status,
        s.views, s.likes, s.comments, s.shares, s.saves, s.follower_delta AS followers_gained, 0 AS leads,
        s.homepage_visits, CAST(s.avg_watch_ms / 1000 AS INTEGER) AS average_watch_seconds, s.completion_rate_bps,
        s.five_second_completion_rate_bps, s.cover_ctr_bps, s.two_second_bounce_rate_bps
      FROM platform_metric_snapshots s
      INNER JOIN platform_works w ON w.id = s.work_id AND w.organization_id = s.organization_id AND w.project_id = s.project_id
      LEFT JOIN videos v ON v.id = w.video_id AND v.organization_id = w.organization_id AND v.project_id = w.project_id AND v.deleted_at IS NULL
      INNER JOIN platform_metric_import_batches b ON b.id = s.import_batch_id AND b.organization_id = s.organization_id AND b.project_id = s.project_id AND b.status = 'completed'
      WHERE s.organization_id = ? AND s.project_id = ?
        AND ${publicPlatformWorkSql("w")}
    ), prior_clocks AS (
      SELECT publication_id,MAX(rtrim(observed_at,'Z')) AS latest_clock
      FROM combined WHERE observed_at IS NOT NULL AND substr(observed_at,1,10)<? GROUP BY publication_id
    ), clock_rows AS (
      SELECT c.*,${metricValues} AS metrics,
        ROW_NUMBER() OVER(PARTITION BY c.publication_id,c.observed_at ORDER BY metric_created_at,metric_id) AS clock_rank,
        FIRST_VALUE(${metricValues}) OVER(PARTITION BY c.publication_id,c.observed_at ORDER BY metric_created_at,metric_id) AS first_metrics
      FROM combined c LEFT JOIN prior_clocks p ON p.publication_id=c.publication_id
      WHERE c.observed_at IS NOT NULL AND substr(c.observed_at,1,10)<=?
        AND (substr(c.observed_at,1,10)>=? OR rtrim(c.observed_at,'Z')=p.latest_clock)
    ), clock_meta AS (
      SELECT publication_id,observed_at,COUNT(*)-1 AS aliases,
        SUM(CASE WHEN metrics IS NOT first_metrics THEN 1 ELSE 0 END) AS conflicts FROM clock_rows GROUP BY publication_id,observed_at
    ), unique_rows AS (
      SELECT c.*,m.aliases,m.conflicts,substr(c.observed_at,1,10) AS day,
        CASE WHEN substr(c.observed_at,1,10)<? THEN 0 ELSE 1 END AS period_group
      FROM clock_rows c JOIN clock_meta m ON m.publication_id=c.publication_id AND m.observed_at=c.observed_at WHERE c.clock_rank=1
    ), ranked AS (
      SELECT unique_rows.*,
        ROW_NUMBER() OVER(PARTITION BY publication_id,day ORDER BY rtrim(observed_at,'Z') DESC) AS day_last,
        ROW_NUMBER() OVER(PARTITION BY publication_id,period_group ORDER BY rtrim(observed_at,'Z')) AS first_group,
        ROW_NUMBER() OVER(PARTITION BY publication_id,period_group ORDER BY rtrim(observed_at,'Z') DESC) AS last_group,
        SUM(aliases) OVER(PARTITION BY publication_id,period_group) AS period_aliases,
        SUM(conflicts) OVER(PARTITION BY publication_id,period_group) AS period_conflicts
      FROM unique_rows
    )
    SELECT ranked.*,
      CASE WHEN period_group=0 THEN aliases WHEN first_group=1 THEN period_aliases ELSE 0 END AS timestamp_aliases,
      CASE WHEN period_group=0 THEN conflicts WHEN first_group=1 THEN period_conflicts ELSE 0 END AS timestamp_conflicts
    FROM ranked WHERE (period_group=1 AND (day_last=1 OR first_group=1)) OR (period_group=0 AND last_group=1)
    ORDER BY rtrim(observed_at,'Z'),metric_created_at,metric_id LIMIT 50001
  `).bind(organizationId, projectId, organizationId, projectId, periodStart, periodEnd, periodStart, periodStart).all<MetricSnapshotRow>();
  if (rows.results.length > 50_000) throw new Error("PERFORMANCE_RESULT_CAPACITY_EXCEEDED");
  return rows.results;
}

async function loadContentEvidence(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, contentItemIds: string[]) {
  const ids = Array.from(new Set(contentItemIds.filter(Boolean)));
  if (!ids.length) return [] as PerformanceEvidenceRef[];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db.prepare(
    "SELECT cc.content_item_id, cc.content_version_id, cv.version, cv.pack_json, cc.citation_type, cc.citation_id, cc.quote, COALESCE(a.title, '') AS source_title, a.source_locator_json " +
    "FROM content_citations cc " +
    "INNER JOIN content_versions cv ON cv.id = cc.content_version_id AND cv.organization_id = cc.organization_id AND cv.project_id = cc.project_id " +
    "INNER JOIN content_items ci ON ci.id = cc.content_item_id AND ci.organization_id = cc.organization_id AND ci.project_id = cc.project_id AND ci.current_version = cv.version " +
    "LEFT JOIN video_knowledge_atoms a ON a.id = cc.citation_id AND a.organization_id = cc.organization_id " +
    "WHERE cc.organization_id = ? AND cc.project_id = ? AND cc.content_item_id IN (" + placeholders + ") " +
    "ORDER BY cc.created_at ASC LIMIT 500",
  ).bind(organizationId, projectId, ...ids).all<ContentEvidenceRow>();
  return buildPerformanceEvidence(rows.results);
}export async function loadPerformanceAnalytics(db: ReturnType<typeof getD1>, organizationId: string, projectId: string, periodStart: string, periodEnd: string) {
  const previous = previousPeriod(periodStart, periodEnd);
  const [currentRows, previousRows] = await Promise.all([
    loadPerformancePeriodRows(db, organizationId, projectId, periodStart, periodEnd),
    loadPerformancePeriodRows(db, organizationId, projectId, previous.periodStart, previous.periodEnd),
  ]);
  const previousSnapshot = buildAnalyticsSnapshot(previousRows, previous.periodStart, previous.periodEnd);
  const snapshot = buildAnalyticsSnapshot(currentRows, periodStart, periodEnd, { periodStart: previous.periodStart, periodEnd: previous.periodEnd, summary: previousSnapshot.summary });
  const evidence = await loadContentEvidence(db, organizationId, projectId, snapshot.topContent.map((item) => item.contentItemId));
  return { ...snapshot, evidence, diagnostics: buildPerformanceDiagnostics({ ...snapshot, evidence }) };
}

export function buildReportNarrative(snapshot: AnalyticsSnapshot) {
  const { summary, topContent } = snapshot;
  if (!summary.contentCount) return { summary: "本报告周期内尚未导入已发布内容的数据快照。", highlights: ["当前没有可计算的内容表现数据。"], recommendations: ["从发布管理下载模板并导入至少一条作品快照。", "统一在固定时间记录累计播放和互动数据，保证周期可比。"] };
  const best = topContent[0]; const engagement = (summary.engagementRate * 100).toFixed(2); const qualifier = summary.baselineCoverage.partial ? "可确认" : "";
  const triggeredRules = snapshot.diagnostics.rules.filter((item) => item.status === "triggered").slice(0, 3);
  const coverageNote = (summary.baselineCoverage.partial ? `其中 ${summary.baselineCoverage.partial} 条历史作品缺少期初快照，增量从本期首条快照起计算。` : "全部纳入作品均有期初快照，或为本期新发布作品。") + (summary.timestampAliases ? `发现 ${summary.timestampAliases} 条同一时刻的历史重复快照，其中 ${summary.timestampConflicts} 条指标不一致；仅使用首个已保存值，原记录未改，请人工核对。` : "");
  const viewsChange = snapshot.comparison?.changeRate.views;
  const comparisonHighlight = viewsChange === null || viewsChange === undefined ? "前一周期没有可比较的新增播放数据。" : `新增播放较前一周期${viewsChange >= 0 ? "增长" : "下降"} ${Math.abs(viewsChange * 100).toFixed(1)}%。`;
  return {
    summary: `本周期纳入 ${summary.contentCount} 条已发布内容，${qualifier}新增播放 ${summary.views.toLocaleString("zh-CN")}，周期互动率 ${engagement}%，${qualifier}新增线索 ${summary.leads.toLocaleString("zh-CN")}。${coverageNote}`,
    highlights: [best ? `周期新增播放最高内容《${best.title}》获得 ${best.views.toLocaleString("zh-CN")} 次新增播放。` : "暂无头部内容。", comparisonHighlight, `${qualifier}新增关注 ${summary.followersGained.toLocaleString("zh-CN")} 个。`, `本周期新增点赞、评论、分享与收藏合计 ${summary.interactions.toLocaleString("zh-CN")} 次。`],
    recommendations: [
      summary.engagementRate < 0.03 ? "当前总互动率低于 3%，优先复盘开头承诺、互动提问和内容受众匹配。" : "互动率表现稳定，继续复用高互动内容的选题角度与开头结构。",
      summary.leads === 0 ? "尚未记录线索，建议统一转化动作并在下一周期补录线索数据。" : "已有线索反馈，下一周期按内容主题拆分线索贡献。",
      best ? "将《" + best.title + "》的结构沉淀回知识库和选题模板。" : "持续积累可比较的数据快照。",
      ...triggeredRules.map((item) => "复盘规则：" + item.label + "。依据：" + item.evidence[0] + "；" + item.uncertainty),
    ],  };
}
