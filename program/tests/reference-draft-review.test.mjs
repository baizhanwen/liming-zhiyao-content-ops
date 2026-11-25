import assert from "node:assert/strict";
import test from "node:test";
import { buildReferenceDraftReview, applyReferenceDraftReview } from "../lib/reference-draft-review.ts";
import { buildReferenceOverlapHints } from "../lib/reference-overlap.ts";

const empty = { spokenText: "", screenText: "", originalSound: "", table: null };
const report = {
  videoId: "video", analysisId: "analysis", topic: "期末周的一天", topicMode: "reference", focus: "记下听见广播的片刻",
  productionBasis: ["strategy", "method_knowledge", "video_analysis"].map(sourceType => ({ sourceType, sourceId: sourceType, quote: "已确认的具体结构与策略", purpose: "写法" })),
  segments: [
    { ...empty, segmentId: "intro", role: "交代背景", materialIds: ["sound"], note: "听到广播后，我松了一口气。", presentation: "spoken", spokenText: "听到广播后，我松了一口气。" },
    { ...empty, segmentId: "detail", role: "呈现细节", materialIds: ["book"], note: "", presentation: "both", spokenText: "我才发现，今天终于可以休息了。", screenText: "今天终于可以休息了" },
    { ...empty, segmentId: "end", role: "结尾", materialIds: ["sound"], note: "", presentation: "original_sound", originalSound: "合书声和椅子轻响。" },
  ],
};
const source = (sourceId, text, sourceType = "knowledge") => ({ sourceId, title: sourceId, sourceType, text });
const sources = [source("sound", "广播后有合书声和椅子轻响。"), source("book", "错题本上保留了同一道题的两遍解法。今天圈住了昨天漏掉的负号。"),
  source("unselected", "未选用的另一本书。"), source("book", "方法示例也有类似措辞。", "method_knowledge")];
const context = buildReferenceDraftReview(report, sources, ["不提院校"]);
const revision = { ...empty, segmentId: "detail", reason: "删去无依据的心理活动，给出本段新细节。", spokenText: "同一道题，两遍解法。", screenText: "两遍解法",
  evidence: [{ sourceId: "book", quote: "同一道题的两遍解法" }] };

test("审读提供完整段序、真实公开材料、逐段补充与用途限制，未选资料和同名方法不进入审读", () => {
  assert.equal(context.focus, report.focus);
  assert.deepEqual(context.disclosureBoundaries, ["不提院校"]);
  assert.deepEqual(context.materials.map(item => item.sourceId), ["sound", "book"]);
  assert.equal(context.materials[1].text, sources[1].text);
  assert.deepEqual(context.segments.map(row => row.segmentId), ["intro", "detail", "end"]);
  assert.deepEqual(context.segments[1].materialIds, ["book"]);
  assert.equal(context.segments[0].note, "听到广播后，我松了一口气。");
  assert.equal(context.segments[0].draft.spokenText, report.segments[0].spokenText);
});

test("只替换指出的段落并保留首尾呼应，修过的字幕、原声、事实出处和骨架仍然一致", () => {
  const original = structuredClone(report);
  const result = applyReferenceDraftReview(context, report, { revisions: [revision] });
  assert.deepEqual(result.revisedSegmentIds, ["detail"]);
  assert.deepEqual(result.revisionEvidence, revision.evidence);
  assert.equal(result.report.segments[1].spokenText, revision.spokenText);
  assert.equal(result.report.segments[1].screenText, revision.screenText);
  assert.deepEqual(result.report.segments[0], report.segments[0]);
  assert.deepEqual(result.report.segments[2], report.segments[2]);
  assert.deepEqual(result.report.productionBasis, report.productionBasis);
  assert.deepEqual(report, original);
  const pass = applyReferenceDraftReview(context, report, { revisions: [] });
  assert.equal(pass.report, report);
  assert.deepEqual(pass.revisedSegmentIds, []);
  const companionEdits = [{ fieldId: "shortScript", text: "同一道题有两遍解法。" }];
  assert.deepEqual(applyReferenceDraftReview(context, report, { revisions: [], companionEdits }).companionEdits, companionEdits);
});

test("只允许本段材料和本段补充的连续原文作为证据", () => {
  for (const evidence of [
    [{ sourceId: "sound", quote: "合书声和椅子轻响" }],
    [{ sourceId: "unselected", quote: "未选用的另一本书" }],
    [{ sourceId: "book", quote: "学生翻开错题本" }],
    [{ sourceId: "note:intro", quote: "我松了一口气" }],
    [{ sourceId: "book", quote: "方法示例也有类似措辞" }],
  ]) assert.throws(() => applyReferenceDraftReview(context, report, { revisions: [{ ...revision, evidence }] }), /本段已选材料或本段补充/);
  const first = { ...revision, segmentId: "intro", spokenText: "我松了一口气。", screenText: "", evidence: [{ sourceId: "note:intro", quote: "我松了一口气" }] };
  assert.equal(applyReferenceDraftReview(context, report, { revisions: [first] }).report.segments[0].spokenText, first.spokenText);
});

test("按用户指定的呈现方式只接收可用通道；越界、重复、漏交字幕或篡改材料仍然拒绝", () => {
  const wrong = [
    [revision, revision], [{ ...revision, segmentId: "unknown", evidence: [] }],
    [{ ...revision, screenText: "" }], [{ ...revision, role: "改骨架" }], [{ ...revision, materialIds: ["sound"] }],
  ];
  for (const revisions of wrong) assert.throws(() => applyReferenceDraftReview(context, report, { revisions }));
  const row = applyReferenceDraftReview(context, report, { revisions: [{ ...revision, originalSound: "多给的原声" }] }).report.segments[1];
  assert.equal(row.presentation, "both");
  assert.equal(row.spokenText, revision.spokenText);
  assert.equal(row.originalSound, "");
});

test("不可缺的事实可以回到既有段落补料，从未核实的半稿里不会写出修订版本", () => {
  const materialQuestions = [{ segmentId: "detail", question: "你愿意公开当时具体想到什么吗？" }];
  const result = applyReferenceDraftReview(context, report, { materialQuestions });
  assert.equal(result.report, report);
  assert.deepEqual(result.materialQuestions, materialQuestions);
  assert.deepEqual(result.revisedSegmentIds, []);
  assert.throws(() => applyReferenceDraftReview(context, report, { materialQuestions, revisions: [revision] }));
});

test("真实验收稿 B2 反复复述的计划改动和错题细节，能定位到具体中段和分镜台词", () => {
  const speech = [
    "桌边摊着的是期末周的复习计划表，上面原本写着“做两页新题”，这一行后来被划掉，下方改成了“重做一道昨天的错题”。",
    "昨天漏写的负号，被今天的笔圈了出来。旁边划掉的计划写着“做两页新题”，改写后的那一行是“重做一道昨天的错题”。",
    "桌边的计划表写着“重做一道昨天的错题”，错题本上那个昨天漏写的负号，也被今天的笔圈了出来。",
    "",
  ];
  const rows = speech.map((spokenText, i) => ({ ...report.segments[1], segmentId: "part-" + (i + 1), spokenText, screenText: "" }));
  const shots = speech.map((text, i) => ({ fieldId: "storyboard." + i + ".script", text }));
  const hints = buildReferenceDraftReview({ ...report, segments: rows }, sources, [], shots).overlapHints;
  const between = hints.find(hint => hint.earlier === "part-2" && hint.later === "part-3");
  assert.equal(between.kind, "several_phrases");
  assert.ok(between.matches.some(hit => hit.phrase === "重做一道昨天的错题" && hit.earlierExcerpt.includes(hit.phrase) && hit.laterExcerpt.includes(hit.phrase)));
  assert.ok(between.matches.some(hit => hit.phrase.includes("负号")));
  assert.ok(hints.some(hint => hint.earlier === "storyboard.1.script" && hint.later === "storyboard.2.script"));
});

test("同一段的字幕、镜头原声、首尾回扣和跨段短道具名称不被当作复述", () => {
  const speech = ["我还记得闭馆那天的声音。", "木桌上搁着错题本。", "错题本下压着一页旧车票。", "我还记得闭馆那天的声音。"];
  const segments = speech.map((spokenText, i) => ({ ...report.segments[1], segmentId: String(i), spokenText, screenText: spokenText }));
  const shots = speech.map((text, i) => ({ fieldId: "storyboard." + i + ".script", text }));
  assert.deepEqual(buildReferenceOverlapHints({ ...report, segments }, shots), []);
});

test("一则反应所针对的对象须由单一原文支撑，不能拼接两条事实或引用稿中没有的短句", () => {
  const rows = report.segments.map(s => s.segmentId === "detail" ? { ...s, materialIds: ["book", "sound"], note: "听到广播后我松了一口气。" } : s);
  const target = { ...report, segments: rows };
  const input = buildReferenceDraftReview(target, sources);
  const joined = "看见负号后我才合上书";
  const response = (spokenText, evidence) => ({ revisions: [{ ...revision, spokenText, evidence }] });
  const fragments = [{ sourceId: "book", quote: "今天圈住了昨天漏掉的负号" }, { sourceId: "sound", quote: "合书声和椅子轻响" }];
  assert.throws(() => applyReferenceDraftReview(input, target, response(joined, fragments.map(f => ({ ...f, claim: joined, kind: "relation" })))), /不能拼接/);
  const claim = "听到广播后，我松了一口气";
  const valid = [{ sourceId: "note:detail", quote: "听到广播后我松了一口气", kind: "relation", claim }];
  assert.equal(applyReferenceDraftReview(input, target, response(claim, valid)).report.segments[1].spokenText, claim);
  assert.throws(() => applyReferenceDraftReview(input, target, response("只有书页声", valid)), /实际短句/);
});

test("证明存在的摘录不支持更强的唯一性", () => {
  const claim = "这里只剩错题本。";
  const evidence = [{ sourceId: "book", quote: sources[1].text, claim, kind: "scope" }];
  assert.throws(() => applyReferenceDraftReview(context, report, { revisions: [{ ...revision, spokenText: claim, evidence }] }), /范围/);
});
