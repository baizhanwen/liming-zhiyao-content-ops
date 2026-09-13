import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  ANALYSIS_RUBRIC_DIMENSIONS,
  AUTHORIZED_METHODOLOGY_CATALOG_VERSION,
  AUTHORIZED_METHODOLOGY_ENTRIES,
  CONTENT_HOOK_TYPES,
  CONTENT_STRATEGY_FAMILIES,
  authorizedMethodologyApplicationPromptSource,
  methodologyPlanPromptSource,
  selectAuthorizedMethodologyPlan,
} from "../lib/authorized-methodology-router.ts";

test("curated catalog has complete provenance and excludes raw customer/example payloads", () => {
  assert.equal(CONTENT_STRATEGY_FAMILIES.length, 10);
  assert.equal(CONTENT_HOOK_TYPES.length, 18);
  assert.equal(ANALYSIS_RUBRIC_DIMENSIONS.length, 9);
  assert.ok(AUTHORIZED_METHODOLOGY_ENTRIES.length >= 20);
  for (const item of AUTHORIZED_METHODOLOGY_ENTRIES) {
    for (const key of ["id", "task", "platform", "stage", "mode", "risk", "source", "version", "requiredEvidence"]) {
      assert.ok(key in item, `${item.id} is missing ${key}`);
    }
    assert.ok(item.requiredEvidence.length > 0, `${item.id} requires an evidence policy`);
    assert.ok(item.source.revision);
    assert.doesNotMatch(item.instruction, /张三说特别好|库存只有500件|去年我发了1万多条|宝宝红屁股/);
  }
});

test("content routing is deterministic and returns the bounded plan contract", () => {
  const input = {
    task: "content",
    query: "给抖音写一条企业AI口播稿，开头要有钩子",
    availableMethodSources: [{ sourceId: "atom-1" }, "atom-2"],
    hasBenchmarks: false,
    hasHistoricalCopies: true,
  };
  const first = selectAuthorizedMethodologyPlan(input);
  const second = selectAuthorizedMethodologyPlan(input);
  assert.deepEqual(first, second);
  assert.equal(first.version, AUTHORIZED_METHODOLOGY_CATALOG_VERSION);
  assert.equal(first.platform, "douyin");
  assert.equal(first.mode, "hook-testing");
  assert.equal(first.corePlaybook.id, "playbook.content.three-mode.v1");
  assert.ok(first.modules.length >= 1 && first.modules.length <= 2);
  assert.ok(first.rules.length >= 3 && first.rules.length <= 6);
  assert.deepEqual(first.selectedIds, first.snapshot.selectedIds);
  assert.deepEqual(first.snapshot.availableMethodSourceIds, ["atom-1", "atom-2"]);
});

test("benchmark content selects structural learning and copying boundary", () => {
  const plan = selectAuthorizedMethodologyPlan({
    task: "content",
    query: "参考这条爆款的结构重写，不要照搬原句",
    mode: "benchmark",
    hasBenchmarks: true,
    hasHistoricalCopies: true,
  });
  assert.equal(plan.mode, "benchmark-structure");
  assert.ok(plan.modules.some((item) => item.id === "module.content.benchmark-boundary.v2"));
  assert.ok(plan.rules.some((item) => item.id === "rule.content.no-copying.v2"));
  assert.ok(plan.rules.some((item) => item.id === "rule.content.source-boundary.v2"));
});

test("selective benchmark revisions preserve old citation text and the path without benchmarks", () => {
  const plan = selectAuthorizedMethodologyPlan({ task: "content", mode: "benchmark", hasBenchmarks: true });
  const source = methodologyPlanPromptSource(plan);
  assert.match(source, /选择性借鉴/);
  assert.doesNotMatch(source, /只抽取钩子|方法库、对标、案例和历史成品只能指导结构/);
  const application = { planId: plan.id, planVersion: plan.version, mode: plan.mode, selectedMethodIds: plan.selectedIds };
  assert.equal(authorizedMethodologyApplicationPromptSource(application), source);
  const legacy = { ...application, selectedMethodIds: plan.selectedIds.map(id => id.replace(/\.v2$/, ".v1")) };
  const legacySource = authorizedMethodologyApplicationPromptSource(legacy);
  assert.match(legacySource, /只抽取钩子机制、段落功能/);
  assert.match(legacySource, /方法库、对标、案例和历史成品只能指导结构/);
  const withoutBenchmarks = selectAuthorizedMethodologyPlan({ task: "content", mode: "complete-script", hasBenchmarks: false });
  assert.equal(withoutBenchmarks.selectedIds.some(id => id.endsWith(".v2")), false);
});

test("analysis routing carries time-coded evidence gates and performance provenance", () => {
  const plan = selectAuthorizedMethodologyPlan({
    task: "analysis",
    query: "分析这个已发布抖音视频的完播和互动表现",
    hasBenchmarks: false,
  });
  assert.equal(plan.mode, "published-performance");
  assert.ok(plan.modules.some((item) => item.id === "module.analysis.full-rubric.v1"));
  assert.ok(plan.rules.some((item) => item.id === "rule.analysis.metric-provenance.v1"));
  assert.ok(plan.rules.some((item) => item.requiredEvidence.some((evidence) => /时间码|采集时间/.test(evidence))));
});

test("prompt serializer makes method/fact boundary and selected evidence visible", () => {
  const plan = selectAuthorizedMethodologyPlan({ task: "topic", query: "为中小企业老板生成AI获客选题" });
  const prompt = methodologyPlanPromptSource(plan);
  assert.match(prompt, /只规定如何创作或分析，不是客户事实/);
  assert.match(prompt, /证据要求/);
  assert.match(prompt, new RegExp(plan.corePlaybook.id.replaceAll(".", "\\.")));
  for (const id of plan.selectedIds) assert.match(prompt, new RegExp(id.replaceAll(".", "\\.")));
});

test("manual content versions can rebuild only a current catalog-backed methodology plan", () => {
  const plan = selectAuthorizedMethodologyPlan({
    task: "content",
    query: "给抖音写一条企业AI口播稿，开头要有钩子",
  });
  const application = {
    planId: plan.id,
    planVersion: plan.version,
    mode: plan.mode,
    selectedMethodIds: plan.selectedIds,
  };
  assert.equal(authorizedMethodologyApplicationPromptSource(application), methodologyPlanPromptSource(plan));
  assert.equal(authorizedMethodologyApplicationPromptSource({ ...application, planId: `${plan.id}.forged` }), null);
  assert.equal(authorizedMethodologyApplicationPromptSource({ ...application, planVersion: "outdated-version" }), null);
  assert.equal(authorizedMethodologyApplicationPromptSource({ ...application, selectedMethodIds: [...plan.selectedIds.slice(0, -1), "rule.content.forged.v1"] }), null);

  const analysisPlan = selectAuthorizedMethodologyPlan({ task: "analysis", query: "分析视频" });
  assert.equal(authorizedMethodologyApplicationPromptSource({
    planId: analysisPlan.id,
    planVersion: analysisPlan.version,
    mode: analysisPlan.mode,
    selectedMethodIds: plan.selectedIds,
  }), null);
});

test("manual save route separates catalog plan ids from authorized atom lookup", async () => {
  const route = await readFile(new URL("../app/api/content-items/[contentId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /authorizedMethodologyApplicationPromptSource/);
  assert.match(route, /filter\(\(id\) => !id\.startsWith\("methodology\."\)\)/);
  assert.match(route, /methodKnowledgeIds\.includes\(methodologyApplication\.planId\)/);
});
