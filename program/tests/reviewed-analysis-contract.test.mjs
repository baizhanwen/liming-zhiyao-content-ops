import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const produced = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v12.json", import.meta.url), "utf8"));

test("actual Python v12 accepts safe completed modules while retaining one explicitly pending manuscript segment", t => {
  const f = runtimeFixture(t), report = structuredClone(produced);
  const quality = f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v12", report);
  assert.equal(quality.accepted, true); assert.equal(quality.manuscriptStatus, "needs_review"); assert.equal(quality.reviewSegmentCount, 1);
  assert.equal(report.unified_report.canonical.validation.passed, false);
  assert.equal(f.load("lib/unified-report.ts").readUnifiedReport(report).version, "unified-report.v2");
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, false);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v13", report).accepted, false);
});

for (const [name, mutate] of [
  ["unverified original in legacy full script", report => report.spoken_script.push(report.unified_report.canonical.segments[1].original_text)],
  ["legacy corrected entry falsely completed", report => { report.spoken_script_set.corrected_original.status = "completed"; }],
  ["pending candidate as accepted text", report => { report.unified_report.canonical.segments[1].text = "Opus 4.5，未经核对的候选。"; }],
  ["inconsistent outcome", report => { report.unified_report.outcome.manuscript = "verified"; }],
  ["wrong pending count", report => { report.unified_report.outcome.review_segment_count = 0; }],
  ["missing coverage", report => { delete report.content_analysis.methodology.transcript_review; }],
  ["pending transcript in registry", report => report.content_analysis.evidence_registry.push({ id: "transcript:0002", source: "transcript", text: "不可靠原文", start_ms: 2300, end_ms: 2600, asset_ref: null, frame_group_id: null })],
  ["pending transcript cited by finding", report => { report.unified_report.sections[0].findings[0].evidence_ids = ["transcript:0002"]; }],
  ["visual finding with only an empty frame", report => { report.unified_report.sections[2].findings[0].evidence_ids = [report.content_analysis.evidence_registry.find(row => row.source === "frame").id]; }],
  ["changed numeric fact in an accepted segment", report => { const row = report.unified_report.canonical.segments[0]; row.original_text = "使用Opus5.5"; row.text = "使用Opus4.5"; }],
]) test(`v12 rejects ${name}`, t => {
  const f = runtimeFixture(t), report = structuredClone(produced); mutate(report);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v12", report).accepted, false);
});

test("v12 completion explains the actual missing visual source and keeps the pending sentence count", t => {
  const f = runtimeFixture(t), report = structuredClone(produced);
  report.unified_report.status = report.unified_report.outcome.report = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["visual:insufficient_evidence_modality:visual.first_frame_information"] };
  Object.assign(report.unified_report.sections[2], { status: "failed", reason: "schema_invalid", findings: [] });
  report.unified_report.sections[2].diagnostics.failure_kind = "schema_invalid";
  Object.assign(report.content_analysis.module_status.visual, { status: "failed", reason: "schema_invalid", validation: { passed: false, issues: ["insufficient_evidence_modality:visual.first_frame_information", "missing_valid_dimensions"] } });
  const message = f.load("lib/analysis-quality.ts").analysisCompletionMessage("analysis.v12", report);
  assert.match(message, /1句口播待核对/); assert.match(message, /首帧信息.*缺少对应的文字或画面依据/);
  assert.doesNotMatch(message, /schema_invalid|missing_valid_dimensions|质量项未通过/);
});

test("uncertainty blocks global absence and quoted CTA stitched across pending source gaps", t => {
  const f = runtimeFixture(t), { readVideoContentAnalysis } = f.load("lib/video-content-analysis.ts");
  const absent = structuredClone(produced.content_analysis);
  Object.assign(absent.classifications.find(row => row.dimension_id === "value.repetition"), { state: "known", tags: ["value.repetition.none"], primary_tag: null, reason: null, evidence_ids: ["transcript:0001"] });
  assert.equal(readVideoContentAnalysis(absent).status, "invalid");
  const stitched = structuredClone(produced.content_analysis), cta = stitched.segments.find(row => row.kind === "cta");
  const texts = stitched.evidence_registry.filter(row => ["transcript:0001", "transcript:0003"].includes(row.id));
  Object.assign(cta, { evidence_ids: texts.map(row => row.id), text: texts.map(row => row.text).join(""), start_ms: 0, end_ms: 5900 });
  const read = readVideoContentAnalysis(stitched); assert.equal(read.status, "invalid"); assert.ok(read.issues.some(issue => issue.includes("待核对口播")));
});

test("safe disjoint semantic summaries and single-frame OCR quotes remain usable", t => {
  const f = runtimeFixture(t), { readVideoContentAnalysis } = f.load("lib/video-content-analysis.ts");
  const content = structuredClone(produced.content_analysis), cta = content.segments.find(row => row.kind === "cta");
  content.evidence_registry.push({ id: "ocr:9999", source: "ocr", text: cta.text, start_ms: 2400, end_ms: 2400, asset_ref: null, frame_group_id: null });
  Object.assign(cta, { evidence_ids: ["ocr:9999"], start_ms: 2400, end_ms: 2400 });
  for (const row of content.classifications.filter(row => ["cta.action", "cta.position"].includes(row.dimension_id))) row.evidence_ids = ["ocr:9999"];
  const structure = content.segments.find(row => row.kind === "structure");
  content.segments.push({ ...structure, id: "structure-safe-disjoint", text: "归纳两个已核对的内容片段。", evidence_ids: ["transcript:0001", "transcript:0003"], start_ms: 0, end_ms: 5900 });
  const read = readVideoContentAnalysis(content); assert.equal(read.status, "valid", JSON.stringify(read.issues));
});

test("every shared downstream source excludes review candidates and cannot treat an accepted subset as a full rewrite manuscript", t => {
  const f = runtimeFixture(t), report = structuredClone(produced), pending = report.unified_report.canonical.segments[1];
  pending.candidate_text = "PRIVATE_UNVERIFIED_CANDIDATE_4.5";
  report.spoken_script_set.corrected_original.text = "PRIVATE_LEGACY_POISON";
  report.recommendations = ["PRIVATE_LEGACY_RECOMMENDATION_POISON"];
  const safe = f.load("lib/unified-report.ts").projectSafeAnalysisReport(report);
  assert.ok(safe); const rendered = JSON.stringify(safe);
  for (const forbidden of [pending.original_text, pending.candidate_text, "PRIVATE_LEGACY_POISON", "PRIVATE_LEGACY_RECOMMENDATION_POISON", "original_text", "candidate_text"]) assert.ok(!rendered.includes(forbidden), forbidden);
  const source = f.load("lib/content-production.ts").analysisReportSourceText(JSON.stringify(report));
  assert.match(source, /已核对2段，共3段/); assert.ok(!source.includes(pending.original_text)); assert.ok(!source.includes(pending.candidate_text));
  assert.equal(f.load("lib/single-benchmark-rewrite.ts").readBenchmarkRewriteSource(JSON.stringify(report), "私下传入的未核对完整ASR"), null);
});

test("comparisons keep full and subset review coverage in separate denominator groups", t => {
  const f = runtimeFixture(t), { aggregateContentComparison } = f.load("lib/video-content-analysis.ts");
  const subset = structuredClone(produced.content_analysis), full = structuredClone(subset);
  full.methodology.transcript_review = { total_segments: 3, accepted_segments: 3, uncertain_segment_ids: [], uncertain_ranges: [], first_source_segment_id: "transcript:0001" };
  const rows = [subset, full].map((contentAnalysis, index) => ({ entryId: `review-entry-${index}`, videoId: `review-video-${index}`, title: "合成", analysisId: `review-analysis-${index}`, analysisCreatedAt: "2026-01-01", contentAnalysis }));
  const result = aggregateContentComparison(rows); assert.equal(result.groupings.length, 2);
  assert.deepEqual(result.groupings.map(group => group.transcriptReviewCoverage).sort(), ["accepted_subset", "verified"]);
  assert.equal(result.distributions.length, 0);
  const legacy = structuredClone(subset); delete legacy.methodology.transcript_review;
  const legacyResult = aggregateContentComparison([{ ...rows[0], contentAnalysis: legacy }]);
  assert.equal(legacyResult.groupings[0].transcriptReviewCoverage, "not_recorded");
  assert.equal(legacyResult.groupings[0].transcriptReviewTotals, null);
});
