import assert from "node:assert/strict";
import test from "node:test";

function row(overrides = {}) {
  return {
    publication_id: "pub-1",
    content_item_id: "content-1",
    title: "示例作品",
    platform: "douyin",
    external_url: null,
    published_at: "2026-07-01T00:00:00.000Z",
    observed_at: "2026-08-01T12:00:00.000Z",
    genre: "教程",
    review_status: "已通过",
    views: 200,
    likes: 20,
    comments: 5,
    shares: 5,
    saves: 5,
    followers_gained: -1,
    leads: 0,
    homepage_visits: 10,
    average_watch_seconds: 8,
    completion_rate_bps: 4000,
    five_second_completion_rate_bps: 7000,
    cover_ctr_bps: 800,
    two_second_bounce_rate_bps: 2000,
    ...overrides,
  };
}

test("performance diagnostics expose five layers, seven rules, and uncertainty for small samples", async () => {
  const diagnostics = await import("../lib/performance-diagnostics.ts");
  const snapshot = {
    periodStart: "2026-08-01",
    periodEnd: "2026-08-01",
    summary: {
      contentCount: 1,
      views: 200,
      interactions: 35,
      followersGained: -1,
      leads: 0,
      engagementRate: 0.175,
      averageCompletionRate: 40,
      baselineCoverage: { total: 1, complete: 0, partial: 1, newPublications: 0 },
    },
    topContent: [{ title: "示例作品", views: 200, interactions: 35 }],
    peerGroups: [{ key: "教程", label: "教程", sampleSize: 1, medianViews: 200, medianCompletionRate: 40, medianEngagementRate: 0.175, periodStart: "2026-08-01", periodEnd: "2026-08-01" }],
  };
  const result = diagnostics.buildPerformanceDiagnostics(snapshot);
  assert.equal(result.version, "performance-diagnostics.v1");
  assert.equal(result.layers.length, 5);
  assert.equal(result.rules.length, 7);
  assert.equal(result.layers.every((layer) => layer.confidence === "low"), true);
  assert.equal(result.rules.filter((rule) => rule.status === "insufficient").length >= 5, true);
  assert.equal(result.rules.find((rule) => rule.code === "BASELINE_PARTIAL")?.status, "triggered");
  assert.equal(result.rules.find((rule) => rule.code === "BASELINE_PARTIAL")?.status, "triggered");
  assert.match(result.attributionNotice, /相关性/);
  assert.match(result.attributionNotice, /管理员确认/);
});

test("analytics runtime links peer medians to triggered rules and report recommendations", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const rows = [];
  for (let index = 1; index <= 4; index += 1) {
    rows.push(row({ publication_id: "pub-" + index, content_item_id: "content-" + index, title: "教程作品 " + index, observed_at: "2026-07-31T12:00:00.000Z", views: 100, likes: 0, comments: 0, shares: 0, saves: 0, followers_gained: 0, leads: 0 }));
    rows.push(row({ publication_id: "pub-" + index, content_item_id: "content-" + index, title: "教程作品 " + index, observed_at: "2026-08-01T12:00:00.000Z", views: 200, likes: 20, comments: 5, shares: 5, saves: 5, followers_gained: -1, leads: 0 }));
  }
  const snapshot = analytics.buildAnalyticsSnapshot(rows, "2026-08-01", "2026-08-01");
  assert.equal(snapshot.summary.contentCount, 4);
  assert.equal(snapshot.summary.views, 400);
  assert.equal(snapshot.peerGroups[0].label, "教程");
  assert.equal(snapshot.peerGroups[0].sampleSize, 4);
  assert.equal(snapshot.peerGroups[0].medianViews, 200);
  assert.equal(snapshot.diagnostics.layers.length, 5);
  assert.equal(snapshot.diagnostics.rules.length, 7);
  assert.equal(snapshot.diagnostics.rules.find((rule) => rule.code === "HIGH_ENGAGEMENT_LOW_REACH")?.status, "triggered");
  assert.equal(snapshot.diagnostics.rules.find((rule) => rule.code === "NEGATIVE_FOLLOWER_DELTA")?.status, "triggered");
  const narrative = analytics.buildReportNarrative(snapshot);
  assert.equal(narrative.recommendations.some((item) => item.includes("复盘规则：")), true);
  assert.equal(narrative.recommendations.some((item) => item.includes("不能直接推断")), true);
});
test("content evidence preserves script structure, video segments, and material citations", async () => {
  const analytics = await import("../lib/performance-analytics.ts");
  const evidence = analytics.buildPerformanceEvidence([
    {
      content_item_id: "content-1",
      content_version_id: "version-1",
      version: 2,
      pack_json: JSON.stringify({ storyboard: [{ shot: "开场", script: "先指出客户损失，再给出判断方法。" }] }),
      citation_type: "video_atom",
      citation_id: "atom-1",
      quote: "客户在前三秒就会决定是否继续看。",
      source_title: "前三秒留存证据",
      source_locator_json: JSON.stringify({ startSec: 0, endSec: 3, segment: "开场" }),
    },
    {
      content_item_id: "content-1",
      content_version_id: "version-1",
      version: 1,
      pack_json: JSON.stringify({ storyboard: [] }),
      citation_type: "knowledge",
      citation_id: "knowledge-1",
      quote: "服务制造业老板。",
      source_title: "客户定位",
      source_locator_json: null,
    },
  ]);
  assert.equal(evidence.some((item) => item.kind === "script_structure" && item.locator === "storyboard[0]"), true);
  assert.equal(evidence.some((item) => item.kind === "video_segment" && item.sourceId === "atom-1" && item.locator?.includes("startSec")), true);
  assert.equal(evidence.some((item) => item.kind === "material" && item.sourceId === "knowledge-1"), true);
});

test("confirmed performance memory keeps its feedback reuse marker during source mapping", async () => {
  const { mapProjectContextSources } = await import("../lib/generation-source-utils.ts");
  const mapped = mapProjectContextSources([
    { sourceType: "memory", sourceId: "memory-feedback", title: "复盘经验", text: "高互动但低分发时调整开头", feedbackReuse: true },
  ], "org-1", "project-1");
  assert.equal(mapped[0].feedbackReuse, true);
});