import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("stage five persists import batches, publication snapshots, and frozen reports", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const table of ["performance_import_batches", "publication_metric_snapshots", "platform_works", "platform_metric_import_batches", "platform_metric_snapshots", "platform_metric_import_errors", "performance_reports"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /idx_performance_imports_project_hash/);
  assert.match(schema, /idx_publication_metrics_publication_observed/);
  assert.match(schema, /idx_performance_reports_project_period_type/);
});

test("analytics subtract period baselines instead of presenting lifetime totals as new growth", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const base = { content_item_id: "content-1", title: "内容一", platform: "douyin", external_url: null, published_at: "2026-08-01T00:00:00.000Z", likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0, average_watch_seconds: null, completion_rate_bps: null };
  const rows = [
    { ...base, publication_id: "pub-1", published_at: "2026-07-20T00:00:00.000Z", observed_at: "2026-07-31T12:00:00.000Z", views: 80, likes: 8 },
    { ...base, publication_id: "pub-1", observed_at: "2026-08-01T12:00:00.000Z", views: 100, likes: 10 },
    { ...base, publication_id: "pub-1", observed_at: "2026-08-02T12:00:00.000Z", views: 150, likes: 15, followers_gained: 3 },
    { ...base, publication_id: "pub-2", content_item_id: "content-2", title: "内容二", observed_at: "2026-08-02T13:00:00.000Z", views: 200, likes: 20, followers_gained: 4 },
  ];
  const snapshot = analytics.buildAnalyticsSnapshot(rows, "2026-08-01", "2026-08-02", { periodStart: "2026-07-30", periodEnd: "2026-07-31", summary: { views: 100, interactions: 10, followersGained: 2, leads: 0 } });
  assert.equal(snapshot.summary.contentCount, 2);
  assert.equal(snapshot.summary.views, 270);
  assert.equal(snapshot.summary.cumulativeViews, 350);
  assert.equal(snapshot.summary.interactions, 27);
  assert.equal(snapshot.summary.engagementRate, 0.1);
  assert.equal(snapshot.summary.followersGained, 7);
  assert.deepEqual(snapshot.summary.baselineCoverage, { total: 2, complete: 2, partial: 0, newPublications: 1 });
  assert.equal(snapshot.comparison.changeRate.views, 1.7);
  assert.deepEqual(snapshot.series.map((item) => [item.date, item.views]), [["2026-08-01", 20], ["2026-08-02", 250]]);
  assert.deepEqual(snapshot.publishedSeries.map((item) => [item.date, item.views, item.interactions]), [["2026-08-01", 350, 35]]);
  assert.equal(snapshot.contentPerformance.length, 2);
});

test("chart datasets keep every work while the ranking remains capped", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const rows = Array.from({ length: 12 }, (_, index) => ({
    publication_id: `pub-${index}`, content_item_id: `content-${index}`, title: `作品${index}`, platform: "douyin", external_url: null,
    published_at: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`, observed_at: "2026-08-20T00:00:00.000Z",
    views: 100 + index, likes: 10 + index, comments: 0, shares: 0, saves: 0, followers_gained: index, leads: 0,
    average_watch_seconds: null, completion_rate_bps: null,
  }));
  const snapshot = analytics.buildAnalyticsSnapshot(rows, "2026-08-01", "2026-08-20");
  assert.equal(snapshot.contentPerformance.length, 12);
  assert.equal(snapshot.publishedSeries.length, 12);
  assert.equal(snapshot.topContent.length, 10);
});
test("old publications without a pre-period snapshot start at the first visible anchor", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const base = { publication_id: "pub-old", content_item_id: "content-old", title: "历史内容", platform: "douyin", external_url: null, published_at: "2026-06-01T00:00:00.000Z", likes: 50, comments: 0, shares: 0, saves: 0, followers_gained: 5, leads: 1, average_watch_seconds: null, completion_rate_bps: null };
  const snapshot = analytics.buildAnalyticsSnapshot([
    { ...base, observed_at: "2026-08-01T12:00:00.000Z", views: 500 },
    { ...base, observed_at: "2026-08-02T12:00:00.000Z", views: 550, likes: 55, followers_gained: 7, leads: 2 },
  ], "2026-08-01", "2026-08-02");
  assert.equal(snapshot.summary.views, 50);
  assert.equal(snapshot.summary.interactions, 5);
  assert.equal(snapshot.summary.followersGained, 2);
  assert.equal(snapshot.summary.baselineCoverage.partial, 1);
  assert.match(analytics.buildReportNarrative(snapshot).summary, /可确认新增播放 50/);
});

test("performance contracts reject untraceable rows and freeze finalized report periods", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const scope = { organizationId: "org-1", projectId: "project-1", source: "csv" };
  const row = { observedAt: "2026-08-05T00:00:00.000Z", views: 100 };
  assert.equal(analytics.performanceImportSchema.safeParse({ ...scope, rows: [row] }).success, false);
  assert.equal(analytics.performanceImportSchema.safeParse({ ...scope, rows: [{ ...row, publicationId: "pub-1" }] }).success, true);
  assert.equal(analytics.createReportSchema.safeParse({ organizationId: "org-1", projectId: "project-1", reportType: "weekly", periodStart: "2026-08-05", periodEnd: "2026-08-01" }).success, false);
});

test("Douyin 16-field snapshots preserve signed followers and ratio distributions", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const scope = { organizationId: "org-1", projectId: "project-1", source: "csv", format: "douyin_16", asOfAt: "2026-08-20T00:00:00.000Z" };
  const row = { title: "作品一", publishedAt: "2026-08-01T00:00:00.000Z", genre: "知识", reviewStatus: "已通过", views: 100, completionRate: 50, fiveSecondCompletionRate: 70, coverCtr: 10, twoSecondBounceRate: 25, avgWatchMs: 12_000, likes: 10, shares: 2, comments: 1, saves: 3, homepageVisits: 20, followerDelta: -4 };
  assert.equal(analytics.douyinPerformanceImportSchema.safeParse({ ...scope, rows: [row] }).success, true);
  const snapshot = analytics.buildAnalyticsSnapshot([{ publication_id: "work-1", content_item_id: "", title: "作品一", platform: "douyin", external_url: null, published_at: row.publishedAt, observed_at: scope.asOfAt, genre: row.genre, review_status: row.reviewStatus, views: row.views, likes: row.likes, shares: row.shares, comments: row.comments, saves: row.saves, followers_gained: row.followerDelta, leads: 0, homepage_visits: row.homepageVisits, average_watch_seconds: 12, completion_rate_bps: 5000, five_second_completion_rate_bps: 7000, cover_ctr_bps: 1000, two_second_bounce_rate_bps: 2500 }], "2026-08-01", "2026-08-20");
  assert.equal(snapshot.summary.followersGained, -4);
  assert.equal(snapshot.summary.homepageVisits, 20);
  assert.equal(snapshot.summary.completionRateDistribution.median, 50);
  assert.equal(snapshot.summary.engagementRate, 0.16);
});

test("performance APIs enforce project access, deduplication, matching, and immutable final reports", async () => {
  const [performance, analytics, reports, finalize] = await Promise.all([
    readFile(new URL("../app/api/performance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analytics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/[reportId]/finalize/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(performance, /getProjectAccess/);
  assert.match(performance, /DUPLICATE_PERFORMANCE_IMPORT/);
  assert.match(performance, /duplicate\.status !== "failed"/);
  assert.match(performance, /未找到当前项目中对应的已发布作品/);
  assert.match(performance, /INSERT OR IGNORE INTO publication_metric_snapshots/);
  assert.match(performance, /douyin_16/);
  assert.match(performance, /AMBIGUOUS_WORK_MATCH/);
  assert.match(performance, /const matched = ambiguous \? undefined/);
  assert.match(performance, /platform_metric_import_batches/);
  assert.match(analytics, /loadPerformanceAnalytics/);
  const analyticsSource = await readFile(new URL("../lib/performance-analytics.ts", import.meta.url), "utf8");
  assert.match(analyticsSource, /b\.status = 'completed'/);
  assert.match(analyticsSource, /SELECT MAX\(previous\.observed_at\)/);
  assert.match(analyticsSource, /safeDelta/);
  assert.match(analyticsSource, /videoId: profile\.latest\.video_id/);
  assert.match(analyticsSource, /LEFT JOIN videos v/);
  assert.match(reports, /FINAL_REPORT_IMMUTABLE/);
  assert.match(finalize, /status = 'draft'/);
  assert.match(finalize, /performance\.report\.finalized/);
});

test("insights routes use ECharts, Papa Parse, and real navigation entries", async () => {
  const [pkg, shell, page, workspace, chart] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/insights/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/InsightsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/EChart.tsx", import.meta.url), "utf8"),
  ]);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(pkg, /"echarts"/);
  assert.match(pkg, /"papaparse"/);
  assert.match(shell, /\/insights\?view=overview/);
  assert.match(shell, /\/insights\?view=reports/);
  assert.match(page, /InsightsWorkspace/);
  assert.match(workspace, /Papa\.parse/);
  assert.match(workspace, /下载 CSV 模板/);
  assert.match(workspace, /report-narrative-grid/);
  assert.match(workspace, /diagnostic-detail-group/);
  assert.match(workspace, /diagnostic-layer-head/);
  assert.match(workspace, /diagnostic-layer-copy/);
  assert.match(workspace, /暂无待补项/);
  assert.match(css, /grid-template-columns: minmax\(135px, \.7fr\) 72px/);
  assert.doesNotMatch(css, /diagnostic-layer\.watch > div span/);
  assert.doesNotMatch(css, /diagnostic-layer::before/);
  assert.match(workspace, /归因规则与数据依据/);
  assert.match(chart, /core\.init/);
  assert.match(workspace, /按发布时间的作品表现/);
  assert.match(workspace, /全部作品表现分布/);
  assert.match(workspace, /analytics\.contentPerformance/);
  assert.match(workspace, /type: "scatter"/);
  assert.match(workspace, /formatter: performanceTooltip/);
  assert.match(workspace, /trigger: "item", confine: true, enterable: true, hideDelay: 180[^\n]+formatter: publishedTrendTooltip/);
  assert.match(workspace, /worksByDate/);
  assert.match(workspace, /Array\.isArray\(params\) \? params : params && typeof params === "object" \? \[params\] : \[\]/);
  assert.match(workspace, /悬停查看视频明细/);
  assert.match(workspace, /已关联视频分析/);
  assert.match(workspace, /查看视频分析/);
  assert.match(workspace, /enterable: true/);
  assert.doesNotMatch(workspace, /\{@\[0\]\}/);
  assert.match(workspace, /height=\{380\}/);
  assert.match(workspace, /singlePublishDate/);
  assert.match(chart, /charts\.ScatterChart/);
});
