import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildEcommerceCopyMethodology } from "../lib/ecommerce/copy-methodology.ts";
import { ECOMMERCE_METHODOLOGY_CATALOG, ecommerceMethodCandidates, getMethodologySelection, methodologySelectionIssues } from "../lib/ecommerce/methodology-catalog.ts";

function context() {
  return { input: {
    task: { brief: { referenceMode: "method", componentIds: [],
      audience: { user: "日常使用者", buyer: "礼品购买者", situation: "日常喝水", status: "hypothesis" },
      scene: "办公室喝水", barrier: "不清楚盖子如何打开", target: "product_click", destination: "当前商品卡查看规格" } },
    product: { claim: { id: "product-claim:fixture", allowedExpression: "合成杯采用旋盖", conditions: "仅可表达已确认的商品基础信息" },
      sellingPoints: "保证改善健康", price: { amountCents: 9900, currency: "CNY" }, offer: null },
    evidence: [{ id: "manual-fixture", kind: "manual_confirmation", body: "人工录入的商品资料" }],
    strategy: null, candidates: [], cases: [],
  } };
}
const hookNames = guide => guide.hookGuidance.candidates.map(item => item.name).join("、");
const familyNames = guide => guide.strategyGuidance.candidates.map(item => item.name);

test("built-in methodology supports complete copy without cards, references or a strategy", () => {
  const input = context(), before = structuredClone(input);
  const guide = buildEcommerceCopyMethodology(input);
  assert.equal(guide.structureAuthority.source, "builtin_methodology");
  assert.deepEqual(guide.structureAuthority.ids, []);
  assert.match(guide.structureAuthority.rule, /完整口播/);
  assert.ok(guide.hookGuidance.candidates.length > 0);
  assert.equal(guide.strategyGuidance.maxPrimary, 1);
  assert.equal(guide.strategyGuidance.maxSupplement, 1);
  assert.equal(guide.materials.action.destination, input.input.task.brief.destination);
  assert.equal(guide.materials.audience.buyer, "礼品购买者");
  assert.deepEqual(input, before, "guidance must not rewrite the task or product facts");
});

test("a selected benchmark stays the sole structure authority even when methods and evidence exist", () => {
  const input = context();
  input.input.task.brief.referenceMode = "benchmark";
  input.input.cases = [{ id: "selected-case" }];
  input.input.candidates = [{ card: { kind: "hook" } }, { card: { kind: "structure" } }];
  input.input.evidence.push({ id: "demo-fixture", kind: "demonstration" });
  const guide = buildEcommerceCopyMethodology(input);
  assert.equal(guide.structureAuthority.source, "selected_benchmark");
  assert.deepEqual(guide.structureAuthority.ids, ["selected-case"]);
  assert.deepEqual(guide.hookGuidance.candidates, []);
  assert.deepEqual(guide.strategyGuidance.candidates, []);
  assert.deepEqual(guide.strategyGuidance.familyIndex, []);
  assert.match(guide.planDirection.referenceAdaptation, /本商品事实/);
});

test("manual confirmation and an entered price never unlock experiment or promotional hooks", () => {
  const input = context();
  input.input.evidence[0].body = "已实验验证，原价199，优惠99，抢购仅剩最后一件";
  const guide = buildEcommerceCopyMethodology(input);
  assert.doesNotMatch(hookNames(guide), /实验|效果前置|价格福利/);
  assert.ok(!familyNames(guide).includes("真实实测验证"));
  assert.ok(!familyNames(guide).includes("福利转化冲刺"));
});

test("proof methods require demonstration evidence and promotion requires a validated offer plus offer evidence", () => {
  const input = context();
  input.input.evidence.push({ id: "demo-fixture", kind: "demonstration" });
  let guide = buildEcommerceCopyMethodology(input);
  assert.match(hookNames(guide), /实验演示/);
  assert.ok(familyNames(guide).includes("真实实测验证"));
  assert.doesNotMatch(hookNames(guide), /价格福利/);

  input.input.product.offer = { priceCents: 9900, currency: "CNY", offer: "已核实的本次活动", validUntil: "2099-12-31T00:00:00Z" };
  guide = buildEcommerceCopyMethodology(input);
  assert.doesNotMatch(hookNames(guide), /价格福利/, "an offer snapshot alone is insufficient");
  input.input.evidence.push({ id: "offer-fixture", kind: "offer" });
  guide = buildEcommerceCopyMethodology(input);
  const promotional = guide.hookGuidance.candidates.find(item => item.name === "价格福利");
  assert.ok(promotional);
  assert.match(promotional.condition, /offer-fixture/);
  assert.ok(familyNames(guide).includes("福利转化冲刺"));
  input.input.product.offer = null;
  assert.doesNotMatch(hookNames(buildEcommerceCopyMethodology(input)), /价格福利/, "offer evidence without a validated offer remains unavailable");
});

test("audience emotion remains a creative hypothesis and entered selling points do not prove effects", () => {
  const input = context();
  input.input.task.brief.audience.status = "confirmed";
  const guide = buildEcommerceCopyMethodology(input);
  assert.equal(guide.materials.audience.status, "confirmed");
  assert.equal(guide.materials.emotion.status, "creative_hypothesis");
  assert.match(guide.materials.firstSellingPoint.rule, /录入卖点.*不能证明功效/);
  assert.equal(guide.materials.firstSellingPoint.allowedExpression, "合成杯采用旋盖");
  assert.doesNotMatch(JSON.stringify(guide), /保证改善健康/);
});

test("only a complete writing-method pair replaces the built-in structure authority", () => {
  const input = context();
  input.input.candidates = [{ id: "hook-method", card: { kind: "hook" } }];
  assert.equal(buildEcommerceCopyMethodology(input).structureAuthority.source, "builtin_methodology");
  input.input.candidates.push({ id: "structure-method", card: { kind: "structure" } });
  input.input.task.brief.componentIds = ["hook-method", "structure-method"];
  const guide = buildEcommerceCopyMethodology(input);
  assert.equal(guide.structureAuthority.source, "selected_method_cards");
  assert.deepEqual(guide.structureAuthority.ids, ["hook-method", "structure-method"]);
});

test("compiled method paragraphs retain exact document text and source hashes instead of invented framework IDs", () => {
  const catalog = ECOMMERCE_METHODOLOGY_CATALOG;
  assert.equal(catalog.hooks.length, 18);
  assert.equal(catalog.frameworks.length, 10);
  assert.equal(catalog.coverage.individualFrameworks, 0);
  assert.equal(catalog.coverage.detailedCategories, 8);
  for (const item of [...catalog.hooks, ...catalog.frameworks, ...catalog.categories]) {
    const bytes = readFileSync(new URL(`../../${item.source.document}`, import.meta.url));
    const normalized = bytes.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    assert.ok(normalized.includes(item.source.excerpt), item.source.document);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.source.sha256);
    assert.ok(item.source.line > 0);
  }
  assert.ok(catalog.frameworks.every(item => item.beats.length >= 4 && !/^F\d+$/.test(item.id)));
});

test("selection freezes only the chosen method paragraphs and rejects unavailable or duplicate choices", () => {
  const input = context(), candidates = ecommerceMethodCandidates(input);
  const choice = { hookId: candidates.hooks[0].id, frameworkId: candidates.frameworks[0].id,
    supplementFrameworkId: "", reason: "开盖问题有明确旋盖事实，用具体选择维度解释操作方式" };
  assert.deepEqual(methodologySelectionIssues(input, choice), []);
  const selected = getMethodologySelection(input, choice), guide = buildEcommerceCopyMethodology(input, choice);
  assert.equal(selected.framework.id, choice.frameworkId);
  assert.equal(guide.methodCandidates.hooks.length, 1);
  assert.equal(guide.methodCandidates.frameworks.length, 1);
  assert.ok(guide.sourceExcerpts.some(source => source.excerpt === selected.framework.source.excerpt));
  assert.ok(!guide.sourceExcerpts.some(source => source.excerpt === candidates.frameworks[1].source.excerpt));
  assert.ok(methodologySelectionIssues(input, { ...choice, hookId: "hook.experiment" }).length);
  assert.ok(methodologySelectionIssues(input, { ...choice, supplementFrameworkId: choice.frameworkId }).length);
  input.input.task.brief.referenceMode = "benchmark";
  assert.ok(methodologySelectionIssues(input, choice).length);
  assert.deepEqual(methodologySelectionIssues(input, null), []);
});

test("course content and actual differences route to concrete selection mechanisms without borrowing example facts", () => {
  const input = context();
  input.input.product.category = "课程与知识服务";
  input.input.product.copyFacts = { content: "PPT需求拆解与表格处理练习", usage: "从自己的PPT需求开始完成一份作业", difference: "每节课配有可改写的模板", delivery: "课程与作业模板", limitations: "需要实际练习", speakerExperience: "" };
  input.input.task.brief.barrier = "担心只讲概念，不知道适不适合自己";
  const candidates = ecommerceMethodCandidates(input);
  assert.ok(candidates.hooks.some(item => item.id === "hook.reverse"));
  assert.ok(candidates.frameworks.some(item => item.id === "framework.selection"));
  const guide = buildEcommerceCopyMethodology(input);
  assert.match(guide.writingRules.join("\n"), /后台分类|资料标注/);
  assert.match(guide.reviewChecklist.join("\n"), /换成任何其他商品/);
  assert.doesNotMatch(JSON.stringify(guide.sourceExcerpts), /七八门课我全试过|一整晚的活/);
});
