import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

function historicalPartialReport(reason = "length") {
  const report = unifiedAnalysisReportFixture(), content = report.content_analysis, unified = report.unified_report;
  report.analysis_meta.contract_version = "analysis.v12";
  report.analysis_meta.transcript_review_enabled = false;
  report.analysis_meta.transcript_source_kind = "asr";
  report.analysis_meta.quality_audit = { status: "review", acceptance_passed: false, completion_status: "partial", issues: [`text_expression_value:${reason}`] };
  content.status = unified.status = "partial";
  content.validation = unified.validation = { passed: false, issues: [`text_expression_value:${reason}`] };
  Object.assign(content.module_status.text_expression_value, { status: "failed", reason, validation: { passed: false, issues: [] } });
  Object.assign(unified.sections[1], { status: "failed", reason, findings: [] });
  Object.assign(unified.sections[1].diagnostics, { failure_kind: "length", finish_reason: "length" });
  content.methodology.transcript_basis = "original";
  content.methodology.transcript_review = { total_segments: 1, accepted_segments: 1, uncertain_segment_ids: [], uncertain_ranges: [], first_source_segment_id: "transcript:0001" };
  unified.version = "unified-report.v2";
  unified.outcome = { processing: "completed", report: "partial", manuscript: "original", review_segment_count: 0 };
  Object.assign(unified.methodology, { pipeline_version: "unified-analysis.v2", canonical_version: "canonical-transcript.v2", transcript_basis: "original" });
  Object.assign(unified.canonical, { version: "canonical-transcript.v2", status: "original" });
  delete unified.canonical.changes;
  for (const segment of unified.canonical.segments) Object.assign(segment, { candidate_text: null, review_status: "original", issues: [] });
  report.spoken_script = [...unified.canonical.paragraphs];
  report.spoken_script_set = { corrected_original: { status: "original", text: report.spoken_script.join("\n"), paragraphs: [...report.spoken_script] } };
  return report;
}

const knownReasons = ["length", "overloaded", "timeout", "provider_error", "schema_invalid", "evidence_invalid", "input_budget", "canonical_failed", "input_budget_exceeded", "classification_request_failed", "not_requested", "upstream_module_failed"];
for (const reason of knownReasons) test(`a historical failed module with empty SDK issues keeps three usable sections: ${reason}`, t => {
  const f = runtimeFixture(t), report = historicalPartialReport(reason), before = JSON.stringify(report);
  const { readContentAnalysis, readVideoContentAnalysis } = f.load("lib/video-content-analysis.ts");
  const content = readVideoContentAnalysis(report.content_analysis);
  assert.equal(content.status, "valid", JSON.stringify(content.issues));
  assert.deepEqual(content.value.module_status.text_expression_value.validation, { passed: false, issues: [reason] });
  assert.ok(readContentAnalysis(report));
  const unified = f.load("lib/unified-report.ts").readVideoUnifiedReport(report.unified_report, content.value);
  assert.equal(unified.status, "valid", JSON.stringify(unified.issues));
  const view = f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", report);
  assert.equal(view.invalid, false); assert.equal(view.complete, false);
  assert.deepEqual(view.sections.map(section => section.status), ["completed", "failed", "completed", "completed"]);
  assert.equal(view.sections.filter(section => section.status === "completed" && section.findings.length).length, 3);
  assert.equal(view.sections[1].findings.length, 0);
  const quality = f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v12", report);
  assert.equal(quality.accepted, false);
  assert.deepEqual(quality.issues, [`text_expression_value:${reason}`, "结构化内容分析尚未完整通过验收。", "统一报告尚未完整通过验收。"]);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(report.content_analysis.module_status.text_expression_value.validation.issues, []);
});

test("the historical recovery reads frozen input without changing evidence, original speech or export bytes", t => {
  const f = runtimeFixture(t), report = historicalPartialReport(), before = JSON.stringify(report);
  const freeze = value => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
  freeze(report);
  const content = f.load("lib/video-content-analysis.ts").readContentAnalysis(report);
  assert.ok(content);
  assert.deepEqual(content.evidence_registry, report.content_analysis.evidence_registry);
  assert.equal(JSON.stringify(report), before);
  const exported = f.load("lib/analysis-diagnostic-export.ts").buildAnalysisDiagnosticExport({
    exportedAt: "2026-01-01T00:00:00.000Z", organizationId: "synthetic-org", projectId: "synthetic-project", sourceProjectId: "synthetic-project",
    video: { id: "synthetic-video" }, analysis: { id: "synthetic-analysis", analysis_job_id: "synthetic-job", schema_version: "analysis.v12", report },
    job: null, latestJob: null, events: [], eventCount: 0, eventsThrough: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(exported.report), before);
});

for (const reason of [null, "", "future_unrecognized_failure", "模型内部报错"]) test(`unknown or absent failure reasons cannot be guessed: ${String(reason)}`, t => {
  const f = runtimeFixture(t), report = historicalPartialReport();
  report.content_analysis.module_status.text_expression_value.reason = reason;
  const result = f.load("lib/video-content-analysis.ts").readVideoContentAnalysis(report.content_analysis);
  assert.equal(result.status, "invalid");
  assert.ok(result.issues.includes("验收结论与问题列表不一致。"));
});

for (const [name, mutate] of [
  ["passed=true with a failure issue", report => { report.content_analysis.module_status.text_expression_value.validation = { passed: true, issues: ["length"] }; }],
  ["completed module with failed empty validation", report => { report.content_analysis.module_status.text_expression_value.status = "completed"; }],
  ["top-level failed empty validation", report => { report.content_analysis.validation = { passed: false, issues: [] }; }],
  ["missing failure issue array", report => { delete report.content_analysis.module_status.text_expression_value.validation.issues; }],
  ["duplicate evidence ID", report => { report.content_analysis.evidence_registry.push(structuredClone(report.content_analysis.evidence_registry[0])); }],
  ["incorrect manuscript coverage", report => { report.content_analysis.methodology.transcript_review.accepted_segments = 0; }],
]) test(`historical metadata recovery still rejects ${name}`, t => {
  const f = runtimeFixture(t), report = historicalPartialReport(); mutate(report);
  assert.equal(f.load("lib/video-content-analysis.ts").readVideoContentAnalysis(report.content_analysis).status, "invalid");
});

for (const [name, mutate] of [
  ["missing registry", report => { report.content_analysis.evidence_registry = []; }],
  ["unknown finding reference", report => { report.unified_report.sections[0].findings[0].evidence_ids = ["transcript:9999"]; }],
  ["duplicate finding references", report => { report.unified_report.sections[0].findings[0].evidence_ids = ["transcript:0001", "transcript:0001"]; }],
  ["visual finding without vision", report => { report.unified_report.sections[2].findings[0].evidence_ids = ["transcript:0001"]; }],
]) test(`historical metadata recovery does not bypass ${name}`, t => {
  const f = runtimeFixture(t), report = historicalPartialReport(); mutate(report);
  const content = f.load("lib/video-content-analysis.ts").readContentAnalysis(report);
  const unified = f.load("lib/unified-report.ts").readVideoUnifiedReport(report.unified_report, content);
  assert.equal(unified.status, "invalid");
  assert.equal(f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", report).invalid, true);
});
