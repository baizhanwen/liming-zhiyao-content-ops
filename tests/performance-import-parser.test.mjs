import test from "node:test";
import assert from "node:assert/strict";
import {
  isMissingMetricCell,
  metricNumberCell,
  percentMetricCell,
  signedMetricNumberCell,
  watchMetricMilliseconds,
} from "../lib/performance-import.ts";
import { douyinPerformanceImportSchema } from "../lib/performance-analytics.ts";

test("抖音导出的横杠占位不会阻断导入", () => {
  for (const value of ["", "-", "--", "—", "–", "N/A", "暂无", "无数据"]) {
    assert.equal(isMissingMetricCell(value), true);
    assert.equal(metricNumberCell(value), 0);
    assert.equal(signedMetricNumberCell(value), 0);
    assert.equal(percentMetricCell(value), undefined);
    assert.equal(watchMetricMilliseconds(value), undefined);
  }
});

test("真实零值与有效数字保持原义", () => {
  assert.equal(metricNumberCell(0), 0);
  assert.equal(metricNumberCell("1,804"), 1804);
  assert.equal(signedMetricNumberCell("-4"), -4);
  assert.equal(percentMetricCell("0.024038"), 2.4038);
  assert.equal(percentMetricCell("24%"), 24);
  assert.equal(watchMetricMilliseconds("00:08"), 8000);
  assert.equal(watchMetricMilliseconds("8.828338"), 8828);
});

test("真正的非法数字仍然被拒绝", () => {
  assert.throws(() => metricNumberCell("abc"), /无效数字/);
  assert.throws(() => percentMetricCell("120%"), /0%～100%/);
});
test("抖音长文案标题可以完整通过服务端校验", () => {
  const row = {
    title: "长".repeat(525),
    publishedAt: "2026-08-01T00:00:00.000Z",
    views: 1,
    likes: 0,
    shares: 0,
    comments: 0,
    saves: 0,
    homepageVisits: 0,
    followerDelta: 0,
  };
  const result = douyinPerformanceImportSchema.safeParse({
    organizationId: "org-1",
    projectId: "project-1",
    source: "xlsx",
    format: "douyin_16",
    asOfAt: "2026-08-27T00:00:00.000Z",
    filename: "作品列表导出-2.xlsx",
    rows: [row],
  });
  assert.equal(result.success, true);
});