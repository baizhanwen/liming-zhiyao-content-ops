import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { analysisReportFixture, unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

test("v11 uses its unified gate, preserves unknown usage, and keeps accepted v10 readable", t => {
  const f = runtimeFixture(t), { assessAnalysisQuality } = f.load("lib/analysis-quality.ts"), { readUnifiedReport } = f.load("lib/unified-report.ts");
  const report = unifiedAnalysisReportFixture(); delete report.analysis_meta.quality_audit;
  assert.equal(assessAnalysisQuality("analysis.v11", report).accepted, true);
  const read = readUnifiedReport(report); assert.ok(read);
  assert.equal(read.sections[0].diagnostics.total_tokens, null);
  assert.equal(read.sections[0].diagnostics.reasoning_tokens, null);
  assert.equal(assessAnalysisQuality("analysis.v10", analysisReportFixture()).accepted, true);
});

for (const [label, mutate] of [
  ["missing unified member", report => { delete report.unified_report; }],
  ["duplicate module", report => { report.unified_report.sections[3].key = "visual"; }],
  ["empty completed findings", report => { report.unified_report.sections[0].findings = []; }],
  ["foreign finding evidence", report => { report.unified_report.sections[0].findings[0].evidence_ids = ["transcript:9999"]; }],
  ["canonical source mismatch", report => { report.unified_report.canonical.segments[0].text = "和分类不同的稿件"; }],
  ["canonical failed despite success audit", report => { report.unified_report.canonical.status = "failed"; }],
  ["not-applicable canonical with real transcript evidence", report => { Object.assign(report.unified_report.canonical, { status: "not_applicable", segments: [], paragraphs: [], changes: [] }); }],
  ["original transcript basis", report => { report.content_analysis.methodology.transcript_basis = "original"; }],
  ["fabricated failure metadata", report => { report.unified_report.sections[0].diagnostics.failure_kind = "api_key_in_error"; }],
]) test(`v11 rejects ${label} despite a passing legacy audit`, t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture(); mutate(report);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, false);
});

test("partial reports retain safe diagnostics while remaining unavailable to acceptance", t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture();
  report.unified_report.status = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["visual:provider_error"] };
  Object.assign(report.content_analysis.module_status.visual, { status: "failed", reason: "classification_request_failed", validation: { passed: false, issues: ["classification_request_failed"] } });
  Object.assign(report.unified_report.sections[2], { status: "failed", findings: [], reason: "classification_request_failed" });
  Object.assign(report.unified_report.sections[2].diagnostics, { failure_kind: "overloaded", http_status: 429, finish_reason: null, attempts: 2, total_tokens: null });
  const read = f.load("lib/unified-report.ts").readUnifiedReport(report);
  assert.ok(read); assert.equal(read.sections[2].diagnostics.http_status, 429); assert.equal(read.sections[2].diagnostics.total_tokens, null);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, false);
});

test("canonical versions cannot be changed by a passing flag or an unrelated OCR number", t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture();
  const segment = report.unified_report.canonical.segments[0];
  segment.original_text = "在 Cursor 里能用到 Opus 5.5"; segment.text = "在 Cursor 里能用到 Opus 4.5";
  report.content_analysis.evidence_registry[0].text = segment.text;
  report.content_analysis.evidence_registry.push({ id: "ocr:0001", source: "ocr", text: "Opus 4.5", start_ms: 0, end_ms: 0, asset_ref: null, frame_group_id: null });
  segment.evidence_ids.push("ocr:0001");
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, false);
});

test("failed numeric candidates remain a readable partial alongside the original registry", t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture(), source = "原文版本为5.5", candidate = "候选稿误改为4.5";
  report.content_analysis.evidence_registry[0].text = source;
  Object.assign(report.unified_report.canonical, { status: "failed", paragraphs: [candidate], validation: { passed: false, issues: ["numeric_or_version_changed"] },
    changes: [{ source_segment_id: "transcript:0001", before: source, after: candidate, evidence_ids: [] }] });
  Object.assign(report.unified_report.canonical.segments[0], { original_text: source, text: candidate });
  report.unified_report.status = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["canonical_failed"] };
  for (const state of Object.values(report.content_analysis.module_status)) Object.assign(state, { status: "failed", reason: "canonical_failed", validation: { passed: false, issues: ["canonical_failed"] } });
  for (const section of report.unified_report.sections) { Object.assign(section, { status: "failed", reason: "canonical_failed", findings: [] }); section.diagnostics.failure_kind = "canonical_failed"; }
  const value = f.load("lib/unified-report.ts").readUnifiedReport(report);
  assert.ok(value); assert.equal(value.status, "partial"); assert.equal(value.canonical.segments[0].text, candidate);
  assert.equal(report.content_analysis.evidence_registry[0].text, source);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, false);
});

for (const [before, after] of [["版本五点五", "版本5.5"], ["M3点1", "M3.1"], ["金额1万元", "金额10000元"], ["金额一万元", "金额10000元"], ["金额5.50元", "金额5.5元"]]) test(`canonical equivalent numeric spelling remains accepted: ${before}`, t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture();
  Object.assign(report.unified_report.canonical.segments[0], { original_text: before, text: after });
  report.content_analysis.evidence_registry[0].text = after;
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v11", report).accepted, true);
});
