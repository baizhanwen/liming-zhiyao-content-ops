import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  benchmarkDirectPerformancePrompt,
  inspectSelectedBenchmarkCoverage,
} from "../lib/benchmark-generation-context.ts";

test("benchmark prompt exposes every direct metric and keeps missing distinct from zero", () => {
  const prompt = benchmarkDirectPerformancePrompt({
    plays: 1200,
    likes: 0,
    comments: 18,
    favorites: null,
    shares: 7,
    followersGained: 3,
    collectedAt: "2026-08-28T09:30:00.000Z",
  });

  assert.match(prompt, /采集时间：2026-08-28T09:30:00\.000Z/);
  assert.match(prompt, /播放：1200/);
  assert.match(prompt, /点赞：0/);
  assert.match(prompt, /评论：18/);
  assert.match(prompt, /收藏：未采集/);
  assert.match(prompt, /分享：7/);
  assert.match(prompt, /涨粉：3/);
  assert.match(prompt, /不得写成当前企业空间的事实/);
});

test("selected benchmark coverage requires citations and method records for every checked source", () => {
  const coverage = inspectSelectedBenchmarkCoverage({
    selectedIds: ["entry-a", "entry-b", "entry-c"],
    citations: [
      { sourceType: "benchmark", sourceId: "entry-a" },
      { sourceType: "knowledge", sourceId: "entry-b" },
      { sourceType: "benchmark", sourceId: "entry-c" },
    ],
    methods: [
      { sourceId: "entry-a" },
      { sourceId: "entry-outside" },
    ],
  });

  assert.deepEqual(coverage.missingCitationIds, ["entry-b"]);
  assert.deepEqual(coverage.missingMethodIds, ["entry-b", "entry-c"]);
  assert.deepEqual(coverage.unexpectedMethodIds, ["entry-outside"]);
});

test("generation reads selected materials from current enterprise-space benchmark bindings and persists usage detail", async () => {
  const route = await readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8");

  assert.match(route, /FROM project_video_references refs\s+INNER JOIN video_library_entries library/);
  assert.match(route, /WHERE refs\.organization_id = \? AND refs\.project_id = \? AND refs\.purpose = 'benchmark' AND refs\.status = 'active'/);
  assert.match(route, /\.bind\(organizationId, projectId, \.\.\.benchmarkEntryIds\)\.all<BenchmarkRow>/);
  assert.doesNotMatch(route, /canAccessOrganizationVideoLibrary|getOrganizationAccess/);
  assert.match(route, /metrics\.collected_at/);
  assert.match(route, /benchmarkDirectPerformancePrompt/);
  assert.match(route, /benchmarkUsageRequirements/);
  assert.match(route, /inspectSelectedBenchmarkCoverage/);
  assert.match(route, /benchmarkCoverage\.missingCitationIds/);
  assert.match(route, /benchmarkCoverage\.missingMethodIds/);
  assert.match(route, /benchmarkUsage,/);
});

test("manual version saves only accept active benchmarks from the current enterprise space", async () => {
  const route = await readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8");

  assert.match(route, /FROM project_video_references refs\s+INNER JOIN video_library_entries library/);
  assert.match(route, /refs\.organization_id = \? AND refs\.project_id = \? AND refs\.purpose = 'benchmark' AND refs\.status = 'active'/);
  assert.match(route, /\.bind\(organizationId, projectId\)\.all<\{ library_entry_id/);
  assert.doesNotMatch(route, /allowed_benchmark_ids|existing\.citation_type = 'benchmark'/);
});
