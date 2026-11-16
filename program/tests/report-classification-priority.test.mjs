import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentTaxonomyFixture } from "./helpers/content-analysis-fixture.mjs";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const produced = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v11.json", import.meta.url), "utf8"));
const row = (dimensionId, state = "known", tags = [{ id: `${dimensionId}.sample`, label: "明确分类", primary: false }]) => ({
  dimensionId, label: dimensionId, state, tags, value: "仅用于展示，不能参与有效性判定", reason: null, featured: false,
});
const read = t => runtimeFixture(t).load("lib/analysis-report-view.ts");
const featuredIds = rows => rows.filter(item => item.featured).map(item => item.dimensionId);

test("all 64 active dimensions have one explicit priority in their own module", t => {
  const { reportClassificationPriority } = read(t);
  const retired = JSON.parse(readFileSync(new URL("../services/analyzer/liming_analyzer/resources/content-report-contract.v1.json", import.meta.url), "utf8")).retired_dimension_ids;
  for (const [module, order] of Object.entries(reportClassificationPriority)) {
    const active = contentTaxonomyFixture.dimensions.filter(item => item.module === module && !retired.includes(item.id));
    assert.equal(new Set(order).size, order.length, module);
    assert.deepEqual([...order].sort(), active.map(item => item.id).sort(), module);
  }
  assert.deepEqual(reportClassificationPriority.text_topic_structure_audience.slice(0, 3), ["topic.category", "topic.problem", "topic.purpose"]);
});

test("an unknown second-priority problem type is retained in More while the seventh valid item fills the sixth slot", t => {
  const { prioritizeReportClassifications, reportClassificationPriority } = read(t);
  const input = reportClassificationPriority.text_topic_structure_audience.slice(0, 7).map(id => row(id));
  Object.assign(input[1], { state: "unknown", tags: [], value: "看似有值的文本不能占位" });
  const before = structuredClone(input);
  const result = prioritizeReportClassifications("text_topic_structure_audience", [...input].reverse());
  assert.deepEqual(result.map(item => item.dimensionId), reportClassificationPriority.text_topic_structure_audience.slice(0, 7));
  assert.deepEqual(featuredIds(result), ["topic.category", "topic.purpose", "structure.type", "audience.role", "audience.need", "topic.angle"]);
  assert.equal(result.find(item => item.dimensionId === "topic.problem").featured, false);
  assert.deepEqual(input, before, "The display projection must not mutate saved rows");
});

test("fewer than six known values leaves fewer primary rows and preserves every other state in More", t => {
  const { prioritizeReportClassifications } = read(t);
  const input = [
    row("topic.category"), row("topic.problem", "unknown", []), row("topic.purpose", "not_acquired", []),
    row("structure.type", "not_applicable", []), row("audience.role", "known", []), row("audience.need"),
  ];
  const result = prioritizeReportClassifications("text_topic_structure_audience", input);
  assert.deepEqual(featuredIds(result), ["topic.category", "audience.need"]);
  assert.equal(result.length, input.length);
  assert.deepEqual(result.filter(item => !item.featured).map(item => item.state), ["unknown", "not_acquired", "not_applicable", "known"]);
});

test("primary eligibility uses state and concrete tags rather than display wording", t => {
  const { prioritizeReportClassifications } = read(t);
  const input = [
    { ...row("hook.type", "unknown"), value: "提问" },
    { ...row("value.type", "not_acquired"), value: "实用价值" },
    { ...row("value.actionability", "not_applicable"), value: "可直接执行" },
    row("technique.retention", "known", []),
    row("technique.trust", "known", [{ id: "valid", label: "  ", primary: false }]),
    { ...row("cta.action"), value: "无法判断", tags: [{ id: "cta.action.none", label: "无行动引导", primary: false }] },
    row("value.repetition", "known", [{ id: "value.repetition.none", label: "无明显重复", primary: false }]),
  ];
  const result = prioritizeReportClassifications("text_expression_value", input);
  assert.deepEqual(featuredIds(result), ["cta.action", "value.repetition"]);
});

test("each direction follows its own stable importance order with at most six concrete classifications", t => {
  const { prioritizeReportClassifications, reportClassificationPriority } = read(t);
  const expected = {
    text_topic_structure_audience: ["topic.category", "topic.problem", "topic.purpose", "structure.type", "audience.role", "audience.need"],
    text_expression_value: ["hook.type", "value.type", "value.actionability", "technique.retention", "technique.trust", "cta.action"],
    visual: ["content.form", "visual.first_frame_style", "visual.opening", "visual.broll", "visual.text_function", "visual.composition"],
    synthesis: ["synthesis.problem", "synthesis.retention", "synthesis.opening_fulfillment", "synthesis.visual_text_relation"],
  };
  for (const [module, order] of Object.entries(reportClassificationPriority)) {
    const result = prioritizeReportClassifications(module, [...order].reverse().map(id => row(id)));
    assert.deepEqual(result.map(item => item.dimensionId), order, module);
    assert.deepEqual(featuredIds(result), expected[module], module);
    assert.equal(result.filter(item => !item.featured).length, Math.max(0, order.length - 6), module);
  }
});

test("future dimensions follow ranked dimensions and preserve their original relative order", t => {
  const { prioritizeReportClassifications } = read(t);
  const result = prioritizeReportClassifications("visual", [row("visual.future_b"), row("visual.opening"), row("visual.future_a"), row("content.form")]);
  assert.deepEqual(result.map(item => item.dimensionId), ["content.form", "visual.opening", "visual.future_b", "visual.future_a"]);
  assert.equal(result.filter(item => item.featured).length, 4);
});

test("real report projection applies priorities without altering raw classifications, evidence or values", t => {
  const { analysisReportView, reportClassificationPriority } = read(t);
  const report = structuredClone(produced);
  const before = JSON.stringify(report);
  const view = analysisReportView("analysis.v11", report);
  assert.equal(view.invalid, false);
  assert.deepEqual(view.sections.map(section => section.classifications.filter(item => item.featured).length), [5, 4, 3, 1]);
  assert.equal(view.sections.flatMap(section => section.classifications).length, 64);
  for (const section of view.sections) {
    assert.deepEqual(section.classifications.map(item => item.dimensionId), reportClassificationPriority[section.key]);
    for (const item of section.classifications.filter(item => item.featured)) {
      assert.equal(item.state, "known"); assert.ok(item.tags.length > 0);
      const source = report.content_analysis.classifications.find(value => value.dimension_id === item.dimensionId);
      assert.deepEqual(item.tags.map(tag => tag.id), source.tags);
    }
  }
  assert.equal(JSON.stringify(report), before);
});
