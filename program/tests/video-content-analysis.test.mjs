import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { aggregateContentComparison, readContentAnalysis, readVideoContentAnalysis } from "../lib/video-content-analysis.ts";
import { assessAnalysisQuality } from "../lib/analysis-quality.ts";
import { analysisReportFixture, contentAnalysisFixture, contentTaxonomyFixture, setKnown } from "./helpers/content-analysis-fixture.mjs";

test("content reader preserves explicit unknown states and never classifies legacy prose", () => {
  const content = contentAnalysisFixture(), before = JSON.stringify(content);
  assert.equal(readVideoContentAnalysis(content).status, "valid");
  assert.deepEqual(readContentAnalysis({ content_analysis: content }), content);
  assert.equal(JSON.stringify(content), before);
  assert.equal(readContentAnalysis({ summary: "这是教育内容，有强烈反转", tags: ["topic.category.education"] }), null);
  content.taxonomy_version = "video-taxonomy.future";
  assert.equal(readVideoContentAnalysis(content).status, "unsupported");
});

test("classification validation rejects guessed empties, foreign tags, absent evidence and mixed none tags", () => {
  const unknown = contentAnalysisFixture(); unknown.classifications[0].tags = [];
  assert.equal(readVideoContentAnalysis(unknown).status, "invalid");
  const missing = setKnown(contentAnalysisFixture(), "topic.category", ["topic.category.education"], "topic.category.education", []);
  assert.equal(readVideoContentAnalysis(missing).status, "invalid");
  const wrong = setKnown(contentAnalysisFixture(), "topic.category", ["unknown.tag"], "unknown.tag");
  assert.equal(readVideoContentAnalysis(wrong).status, "invalid");
  const dimension = contentTaxonomyFixture.dimensions.find(row => row.none_tag_id);
  const mixed = setKnown(contentAnalysisFixture(), dimension.id, [dimension.none_tag_id, dimension.tags.find(tag => !tag.disabled && tag.id !== dimension.none_tag_id).id], dimension.none_tag_id);
  assert.equal(readVideoContentAnalysis(mixed).status, "invalid");
  const complete = setKnown(contentAnalysisFixture(), "topic.category", ["topic.category.education"], "topic.category.education");
  assert.equal(readVideoContentAnalysis(complete).status, "valid");
});

test("temporal classifications need three distinct ordered real frames and a real observation", () => {
  const dimension = contentTaxonomyFixture.dimensions.find(row => row.requires === "temporal");
  const tag = dimension.tags.find(row => !row.disabled && row.id !== dimension.none_tag_id).id;
  const content = setKnown(contentAnalysisFixture(), dimension.id, [tag], dimension.primary_required ? tag : null, ["temporal:group-1", "vision:0001"]);
  content.evidence_registry.push({ id: "temporal:group-1", source: "temporal", text: JSON.stringify({ timestamps_ms: [0, 100, 200] }), start_ms: 0, end_ms: 200, asset_ref: null, frame_group_id: "group-1" });
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
  for (let index = 0; index < 3; index++) content.evidence_registry.push({ id: `frame:${String(index + 1).padStart(4, "0")}`, source: "frame", text: "实际帧占位", start_ms: index * 100, end_ms: index * 100, asset_ref: `fixture-frame-${index}`, frame_group_id: "group-1" });
  for (let index = 0; index < 3; index++) content.evidence_registry.push({ id: `vision:${String(index + 1).padStart(4, "0")}`, source: "vision", text: "合成的已采集视觉观察", start_ms: index * 100, end_ms: index * 100, asset_ref: null, frame_group_id: null });
  assert.equal(readVideoContentAnalysis(content).status, "valid");
  content.evidence_registry.find(row => row.id === "frame:0003").start_ms = 100;
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
});

test("the shared Python-generated contract fixture is accepted by the TypeScript reader", () => {
  const content = JSON.parse(readFileSync(new URL("../services/analyzer/tests/fixtures/content-analysis-v1.json", import.meta.url), "utf8"));
  const parsed = readVideoContentAnalysis(content);
  assert.equal(parsed.status, "valid", parsed.issues.join("; "));
});

test("segments stay within cited evidence and information duplicates refer backwards", () => {
  const content = contentAnalysisFixture();
  const action = contentTaxonomyFixture.dimensions.find(row => row.id === "cta.action");
  content.segments.push({ id: "cta:1", kind: "cta", dimension_id: action.id, tags: [action.tags.find(row => row.id !== action.none_tag_id && !row.disabled).id], start_ms: 0, end_ms: 1_001, text: "合成CTA", evidence_ids: ["transcript:0001"] });
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
  content.segments[0].end_ms = 1_000;
  const type = contentTaxonomyFixture.dimensions.find(row => row.id === "value.information_type").tags[0].id;
  content.information_units.push({ id: "unit:1", type_tag: type, text: "信息单元", evidence_ids: ["transcript:0001"], duplicate_of: "unit:2" });
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
  content.information_units[0].duplicate_of = null;
  assert.equal(readVideoContentAnalysis(content).status, "valid");
});

test("comparison uses known-video denominators and keeps event counts separate", () => {
  const dimension = contentTaxonomyFixture.dimensions.find(row => row.id === "topic.problem");
  const [a, b] = dimension.tags.slice(0, 2).map(row => row.id);
  const first = setKnown(contentAnalysisFixture(), dimension.id, [a, b]);
  const second = setKnown(contentAnalysisFixture(), dimension.id, [a]);
  const action = contentTaxonomyFixture.dimensions.find(row => row.id === "cta.action");
  first.segments = [1, 2].map(index => ({ id: `cta:${index}`, kind: "cta", dimension_id: action.id, tags: [action.tags.find(row => row.id !== action.none_tag_id && !row.disabled).id], start_ms: null, end_ms: null, text: "合成CTA", evidence_ids: ["transcript:0001"] }));
  second.segments = [{ ...first.segments[0] }];
  const type = contentTaxonomyFixture.dimensions.find(row => row.id === "value.information_type").tags[0].id;
  first.information_units = [{ id: "unit:1", type_tag: type, text: "原单元", evidence_ids: ["transcript:0001"], duplicate_of: null }, { id: "unit:2", type_tag: type, text: "重复单元", evidence_ids: ["transcript:0001"], duplicate_of: "unit:1" }];
  const rows = [first, second, contentAnalysisFixture()].map((contentAnalysis, index) => ({ entryId: `entry-${index}`, videoId: `video-${index}`, title: "合成", analysisId: `analysis-${index}`, analysisCreatedAt: "2026-01-01", contentAnalysis }));
  const result = aggregateContentComparison([...rows, rows[0]]);
  const distribution = result.distributions.find(row => row.dimensionId === dimension.id);
  assert.equal(result.coverage.includedVideos, 3);
  assert.equal(distribution.knownCount, 2);
  assert.equal(distribution.stateCounts.unknown, 1);
  assert.equal(distribution.tags.find(row => row.id === a).percent, 100);
  assert.equal(distribution.tags.find(row => row.id === b).percent, 50);
  assert.equal(result.groupings[0].metricsTotals.ctaOccurrences, 3);
  assert.equal(result.groupings[0].metricsTotals.videosWithCtaOccurrences, 2);
  assert.equal(result.groupings[0].metricsTotals.informationUnits, 2);
  assert.equal(result.groupings[0].metricsTotals.uniqueInformationUnits, 1);
  rows[1].contentAnalysis.methodology.sampling_config.interval_seconds = 2;
  const grouped = aggregateContentComparison(rows);
  assert.equal(grouped.groupings.length, 2);
  assert.deepEqual(grouped.distributions, []);
});

test("all current report contracts use the same quality gate and unknown versions are never accepted", () => {
  const passed = { analysis_meta: { quality_audit: { status: "passed", acceptance_passed: true, completion_status: "complete" } } };
  for (const schema of ["analysis.v7", "analysis.v8", "analysis.v9"]) {
    assert.equal(assessAnalysisQuality(schema, passed).accepted, true);
    assert.equal(assessAnalysisQuality(schema, {}).accepted, false);
  }
  assert.equal(assessAnalysisQuality("analysis.vfuture", passed).accepted, false);
  assert.equal(assessAnalysisQuality("analysis.v1", { legacy: true }).accepted, true);
  assert.equal(assessAnalysisQuality("analysis.v10", passed).accepted, false);
  const report = analysisReportFixture();
  assert.equal(assessAnalysisQuality("analysis.v10", report).accepted, true);
  report.content_analysis.status = "partial"; report.content_analysis.validation.passed = false;
  assert.equal(assessAnalysisQuality("analysis.v10", report).accepted, false);
});

for (const dimensionId of ["cta.action", "cta.position", "value.information_type", "structure.role", "structure.type", "topic.problem", "topic.granularity"]) test(`${dimensionId} positive labels require matching structured content from the same evidence`, () => {
  const dimension = contentTaxonomyFixture.dimensions.find(row => row.id === dimensionId);
  const tag = dimension.tags.find(row => !row.disabled && row.id !== dimension.none_tag_id && !["structure.type.weak", "topic.granularity.broad"].includes(row.id)).id;
  const content = setKnown(contentAnalysisFixture(), dimensionId, [tag], dimension.primary_required ? tag : null);
  content.evidence_registry.push({ ...content.evidence_registry[0], id: "transcript:0002", text: "另一条实际来源。" });
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
  if (dimensionId === "value.information_type") content.information_units.push({ id: "unit:1", type_tag: tag, text: "对应信息", evidence_ids: ["transcript:0002"], duplicate_of: null });
  else {
    const action = contentTaxonomyFixture.dimensions.find(row => row.id === "cta.action");
    const ctaTag = action.tags.find(row => !row.disabled && row.id !== action.none_tag_id).id;
    const isCta = dimensionId.startsWith("cta.");
    content.segments.push({ id: "segment:1", kind: isCta ? "cta" : dimensionId === "topic.problem" ? "topic_problem" : dimensionId === "topic.granularity" ? "topic_subject" : "structure", dimension_id: isCta ? "cta.action" : dimensionId === "structure.role" ? dimensionId : null, tags: isCta ? [dimensionId === "cta.action" ? tag : ctaTag] : dimensionId === "structure.role" ? [tag] : [], start_ms: null, end_ms: null, text: "对应的具体内容", evidence_ids: ["transcript:0002"] });
  }
  assert.equal(readVideoContentAnalysis(content).status, "invalid", "Matching timestamps alone must not substitute for the same evidence ID");
  if (dimensionId === "value.information_type") content.information_units[0].evidence_ids = ["transcript:0001"];
  else content.segments[0].evidence_ids = ["transcript:0001"];
  const parsed = readVideoContentAnalysis(content);
  assert.equal(parsed.status, "valid", parsed.issues.join("; "));
});
