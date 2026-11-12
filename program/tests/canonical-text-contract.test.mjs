import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

const reviewedFixture = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v12.json", import.meta.url), "utf8"));

for (const [label, source] of [
  ["SDK-sized Chinese", "文".repeat(12_000)],
  ["SDK-sized astral characters", "😀".repeat(12_000)],
  ["long manual source with whitespace", "\n  " + "原文".repeat(30_000) + "  \n"],
]) test(`canonical source readers preserve ${label} under the shared report budget`, t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture();
  const canonical = report.unified_report.canonical;
  Object.assign(canonical.segments[0], { text: source, original_text: source });
  canonical.paragraphs = [source];
  report.content_analysis.evidence_registry[0].text = source;
  const read = f.load("lib/unified-report.ts").readUnifiedReport(report);
  assert.ok(read);
  assert.equal(read.canonical.segments[0].text, source);
  assert.equal(read.canonical.segments[0].original_text, source);
  assert.equal(read.canonical.paragraphs[0], source);
});

test("legacy canonical changes preserve full before and after strings", t => {
  const f = runtimeFixture(t), report = unifiedAnalysisReportFixture();
  const before = "\n  " + "原文".repeat(6_000) + "  \n", after = before + "。";
  Object.assign(report.unified_report.canonical.segments[0], { original_text: before, text: after });
  report.unified_report.canonical.paragraphs = [after];
  report.unified_report.canonical.changes = [{ source_segment_id: "transcript:0001", before, after, evidence_ids: ["transcript:0001"] }];
  report.content_analysis.evidence_registry[0].text = after;
  const read = f.load("lib/unified-report.ts").readUnifiedReport(report);
  assert.ok(read);
  assert.equal(read.canonical.changes[0].before, before);
  assert.equal(read.canonical.changes[0].after, after);
});

test("reviewed accepted source and pending candidate preserve legal long Unicode text", t => {
  const f = runtimeFixture(t), report = structuredClone(reviewedFixture);
  const accepted = report.unified_report.canonical.segments[0];
  const source = "\n " + accepted.original_text + "😀".repeat(12_000) + " \n";
  accepted.text = accepted.original_text = source;
  report.content_analysis.evidence_registry.find(row => row.id === accepted.source_segment_id).text = source;
  const pending = report.unified_report.canonical.segments.find(row => row.review_status === "needs_review");
  pending.text = pending.original_text = "原文".repeat(6_000);
  pending.candidate_text = "\n " + "候选😀".repeat(6_000) + " \n";
  const read = f.load("lib/unified-report.ts").readUnifiedReport(report);
  assert.ok(read);
  assert.equal(read.canonical.segments[0].original_text, source);
  assert.equal(read.canonical.segments.find(row => row.review_status === "needs_review").candidate_text, pending.candidate_text);
});

test("unified report storage boundary uses serialized UTF-16 units including emoji", t => {
  const f = runtimeFixture(t), report = structuredClone(reviewedFixture);
  const limit = f.load("lib/content-report-contract.ts").CONTENT_REPORT_MAX_UTF16_UNITS;
  const pending = report.unified_report.canonical.segments.find(row => row.review_status === "needs_review");
  pending.candidate_text = "";
  const available = limit - JSON.stringify(report.unified_report).length;
  pending.candidate_text = "😀".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
  assert.equal(JSON.stringify(report.unified_report).length, limit);
  const reader = f.load("lib/unified-report.ts").readVideoUnifiedReport;
  const accepted = reader(report.unified_report, report.content_analysis);
  assert.equal(accepted.status, "valid", JSON.stringify(accepted.issues));
  assert.equal(accepted.value.canonical.segments.find(row => row.review_status === "needs_review").candidate_text, pending.candidate_text);
  pending.candidate_text += "😀";
  assert.equal(JSON.stringify(report.unified_report).length, limit + 2);
  const rejected = reader(report.unified_report, report.content_analysis);
  assert.equal(rejected.status, "invalid");
  assert.match(rejected.issues.join(" "), /体积限制/);
});
