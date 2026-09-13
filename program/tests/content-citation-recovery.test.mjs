import assert from "node:assert/strict";
import test from "node:test";
import { applyCitationRepair, buildCitationDraftAnchors, CITATION_REPAIR_SYSTEM, deduplicateTraceableCitations, isCitationRepairError } from "../lib/content-citation-recovery.ts";
import { createProductionScaffold, productionPackSchema } from "../lib/content-production.ts";

const sources = [
  { sourceType: "topic", sourceId: "topic-1", text: "用实际操作验证代码而不是只看运行成功" },
  { sourceType: "method_knowledge", sourceId: "plan-1", text: "每条视频只解释一个核心机制，并用具体演示兑现开头承诺" },
  { sourceType: "benchmark", sourceId: "benchmark-1", text: "通过连续点击开始按钮检验是否重复启动" },
];
const original = { sourceType: "topic", sourceId: "topic-1", quote: sources[0].text };
function draft() {
  return { ...createProductionScaffold({ id: "topic-1", title: sources[0].text }), fullScript: "让AI写一个倒计时，我连续点击开始按钮，检查它会不会重复启动。", citations: [{ ...original }] };
}
function patch() {
  return { citations: [{ sourceType: "method_knowledge", sourceId: "plan-1", quote: "每条视频只解释一个核心机制", draftQuote: "我连续点击开始按钮", application: "围绕倒计时的重复启动进行具体演示，支撑单一验收问题。" }] };
}

test("valid repeated sources merge without changing the draft or mutating input", () => {
  const pack = { ...draft(), citations: [original, { ...original, quote: "验证代码而不是只看运行成功" }] };
  const before = structuredClone(pack);
  const normalized = deduplicateTraceableCitations(pack, sources);
  assert.equal(productionPackSchema.safeParse(normalized).success, true);
  assert.deepEqual(normalized.citations, [original]);
  assert.equal(normalized.fullScript, pack.fullScript);
  assert.deepEqual(pack, before);
});

test("a fabricated duplicate or an unknown source is not silently removed", () => {
  for (const citations of [
    [original, { ...original, quote: "使用本方法能够保证找到高薪实习" }],
    [{ ...original, sourceId: "other-project" }, { ...original, sourceId: "other-project" }],
  ]) {
    const normalized = deduplicateTraceableCitations({ ...draft(), citations }, sources);
    assert.equal(normalized.citations.length, 2);
    assert.equal(productionPackSchema.safeParse(normalized).success, false);
  }
});

test("repair adds a verified plan citation and retains every other draft field and valid citation", () => {
  const pack = draft();
  const before = structuredClone(pack);
  const repaired = applyCitationRepair(pack, patch(), sources, []);
  assert.deepEqual(repaired.pack, { ...pack, citations: [...pack.citations, { sourceType: "method_knowledge", sourceId: "plan-1", quote: "每条视频只解释一个核心机制" }] });
  assert.deepEqual(pack, before);
  assert.equal(repaired.applications.citations[0].draftQuote, "我连续点击开始按钮");
});

test("repair cannot inject text changes, foreign sources, fabricated evidence or a nonexistent application", () => {
  const variants = [
    { ...patch(), fullScript: "修改了正文" },
    { citations: [{ ...patch().citations[0], sourceId: "another-project-plan" }] },
    { citations: [{ ...patch().citations[0], quote: "这段话没有出现在任何实际提供的资料里" }] },
    { citations: [{ ...patch().citations[0], draftQuote: "我已经成功获得了一份高薪工作" }] },
    { citations: [...patch().citations, ...patch().citations] },
  ];
  for (const value of variants) assert.throws(() => applyCitationRepair(draft(), value, sources, []));
});

test("repair refuses to hide unresolved invalid citations and only replaces verified excerpts", () => {
  const pack = { ...draft(), citations: [{ ...original, quote: "这段引用不存在于真实选题原文中" }] };
  assert.throws(() => applyCitationRepair(pack, patch(), sources, []), /仍有无法核实/);
  const repaired = applyCitationRepair(pack, { citations: [{ ...original, draftQuote: "我连续点击开始按钮", application: "实际操作验证代码是否重复启动，落实选题中的验收要求。" }] }, sources, []);
  assert.deepEqual(repaired.pack.citations, [original]);
});

test("benchmark repairs cannot add an unselected reference", () => {
  assert.throws(() => applyCitationRepair(draft(), { citations: [], benchmarkMethods: [{ sourceId: "benchmark-1", method: "真实操作", draftQuote: "我连续点击开始按钮", application: "对倒计时重复点击进行验证，展示实际操作过程。" }] }, sources, []), /未选择/);
});

test("only citation failures enter the targeted repair path", () => {
  assert.equal(isCitationRepairError("METHODOLOGY_PLAN_CITATION_REQUIRED"), true);
  assert.equal(isCitationRepairError("BENCHMARK_METHOD_REQUIRED"), true);
  assert.equal(isCitationRepairError("MODEL_TIMEOUT"), false);
  assert.equal(isCitationRepairError("INVALID_MODEL_OUTPUT"), false);
});

test("indexed anchors resolve to actual draft text without changing the draft", () => {
  const pack = draft(), before = structuredClone(pack);
  const anchor = buildCitationDraftAnchors(pack)[0];
  const citation = { ...patch().citations[0] };
  delete citation.draftQuote;
  const repaired = applyCitationRepair(pack, { citations: [{ ...citation, draftAnchorId: anchor.id }] }, sources, []);
  assert.equal(repaired.applications.citations[0].draftQuote, anchor.text);
  assert.equal(repaired.pack.fullScript, pack.fullScript);
  assert.deepEqual(pack, before);
});

test("stitched passages, invented anchor ids and conflicting quotes stay rejected", () => {
  const pack = { ...draft(), fullScript: "第一部分，背景。你是谁，你现在什么情况。比如我是计算机专业大二学生。\n\n第二部分，目标。你到底要什么结果。" };
  const citation = { ...patch().citations[0] };
  delete citation.draftQuote;
  for (const anchor of [
    { draftQuote: "第一部分，背景。你是谁，你现在什么情况。第二部分，目标。你到底要什么结果。" },
    { draftAnchorId: "hooks:0" },
    { draftAnchorId: "fullScript:0", draftQuote: "我已经成功获得了一份高薪工作" },
    {},
  ]) assert.throws(() => applyCitationRepair(pack, { citations: [{ ...citation, ...anchor }] }, sources, []));
});

test("indexed benchmark applications retain only production method fields", () => {
  const anchor = buildCitationDraftAnchors(draft())[0];
  const method = { sourceId: "benchmark-1", method: "真实操作", application: "对倒计时重复点击进行验证，展示实际操作过程。" };
  const repaired = applyCitationRepair(draft(), { citations: [], benchmarkMethods: [{ ...method, draftAnchorId: anchor.id }] }, sources, [method.sourceId]);
  assert.deepEqual(repaired.pack.qualityReview.benchmarkMethods, [method]);
});

test("citation-only repair preserves existing selective content notes without adding required fields", () => {
  assert.match(CITATION_REPAIR_SYSTEM, /内容借鉴是可选的/);
  assert.match(CITATION_REPAIR_SYSTEM, /不为补引用添加观点、案例或改写正文/);
  const pack = draft();
  const method = { sourceId: "benchmark-1", method: "操作检查", application: "借鉴重复启动的检查方法作为验收例子，保留外部案例归属。" };
  pack.qualityReview.benchmarkMethods = [method];
  const repaired = applyCitationRepair(pack, patch(), sources, [method.sourceId]);
  assert.deepEqual(repaired.pack.qualityReview.benchmarkMethods, [method]);
  assert.equal(repaired.pack.fullScript, pack.fullScript);
});
