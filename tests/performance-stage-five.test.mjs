import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("stage five persists import batches, publication snapshots, and frozen reports", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const table of ["performance_import_batches", "publication_metric_snapshots", "performance_reports"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /idx_performance_imports_project_hash/);
  assert.match(schema, /idx_publication_metrics_publication_observed/);
  assert.match(schema, /idx_performance_reports_project_period_type/);
});

test("analytics use each publication latest cumulative snapshot without double counting", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const base = { content_item_id: "content-1", title: "内容一", platform: "douyin", external_url: null, published_at: "2026-08-01T00:00:00.000Z", likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0, average_watch_seconds: null, completion_rate_bps: null };
  const rows = [
    { ...base, publication_id: "pub-1", observed_at: "2026-08-01T12:00:00.000Z", views: 100, likes: 10 },
    { ...base, publication_id: "pub-1", observed_at: "2026-08-02T12:00:00.000Z", views: 150, likes: 15, followers_gained: 3 },
    { ...base, publication_id: "pub-2", content_item_id: "content-2", title: "内容二", observed_at: "2026-08-02T13:00:00.000Z", views: 200, likes: 20, followers_gained: 4 },
  ];
  const snapshot = analytics.buildAnalyticsSnapshot(rows, "2026-08-01", "2026-08-02");
  assert.equal(snapshot.summary.contentCount, 2);
  assert.equal(snapshot.summary.views, 350);
  assert.equal(snapshot.summary.interactions, 35);
  assert.equal(snapshot.summary.engagementRate, 0.1);
  assert.equal(snapshot.summary.followersGained, 7);
  assert.deepEqual(snapshot.series.map((item) => [item.date, item.views]), [["2026-08-01", 100], ["2026-08-02", 350]]);
});

test("performance contracts reject untraceable rows and freeze finalized report periods", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const scope = { organizationId: "org-1", projectId: "project-1", source: "csv" };
  const row = { observedAt: "2026-08-05T00:00:00.000Z", views: 100 };
  assert.equal(analytics.performanceImportSchema.safeParse({ ...scope, rows: [row] }).success, false);
  assert.equal(analytics.performanceImportSchema.safeParse({ ...scope, rows: [{ ...row, publicationId: "pub-1" }] }).success, true);
  assert.equal(analytics.createReportSchema.safeParse({ organizationId: "org-1", projectId: "project-1", reportType: "weekly", periodStart: "2026-08-05", periodEnd: "2026-08-01" }).success, false);
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
  assert.match(analytics, /loadPerformanceAnalytics/);
  assert.match(await readFile(new URL("../lib/performance-analytics.ts", import.meta.url), "utf8"), /b\.status = 'completed'/);
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
  assert.match(pkg, /"echarts"/);
  assert.match(pkg, /"papaparse"/);
  assert.match(shell, /\/insights\?view=overview/);
  assert.match(shell, /\/insights\?view=reports/);
  assert.match(page, /InsightsWorkspace/);
  assert.match(workspace, /Papa\.parse/);
  assert.match(workspace, /下载 CSV 模板/);
  assert.match(chart, /core\.init/);
});
