import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readVideoContentAnalysis } from "../lib/video-content-analysis.ts";
import { assessAnalysisQuality } from "../lib/analysis-quality.ts";
import { CONTENT_REPORT_MAX_UTF16_UNITS } from "../lib/content-report-contract.ts";
import { analysisReportFixture, contentAnalysisFixture } from "./helpers/content-analysis-fixture.mjs";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Python-generated dense OCR survives the web reader, quality gate and completion payload unchanged", t => {
  const projectPython = path.join(root, "services/analyzer/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = existsSync(projectPython) ? projectPython : process.env.PYTHON || "python";
  const script = [
    "import json",
    "from test_content_analysis import synthetic_inputs",
    "from test_content_module_protocol import compact_synthetic_response",
    "from liming_analyzer.content_analysis import build_content_analysis_bundle",
    "inputs=synthetic_inputs()",
    "raw='  会议待办三要素😀\\n' + '完整画面原文' * 700 + '\\n  '",
    "inputs[2].keyframes[0].ocr_text=raw",
    "content=build_content_analysis_bundle(*inputs, compact_synthetic_response, profile='max')['content_analysis']",
    "print(json.dumps({'content':content,'raw':raw},ensure_ascii=False))",
  ].join("\n");
  const generated = JSON.parse(execFileSync(python, ["-c", script], {
    cwd: root, encoding: "utf8", maxBuffer: 4_000_000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONPATH: ["services/analyzer", "services/analyzer/tests"].join(path.delimiter) },
  }));
  const parsed = readVideoContentAnalysis(generated.content);
  assert.equal(parsed.status, "valid", JSON.stringify(parsed.issues));
  assert.equal(parsed.value.evidence_registry.find(row => row.id === "ocr:0001").text, generated.raw);
  const report = analysisReportFixture(generated.content);
  const quality = assessAnalysisQuality("analysis.v10", report);
  assert.equal(quality.accepted, true, JSON.stringify({ quality, status: generated.content.status, validation: generated.content.validation, modules: generated.content.module_status }));
  const f = runtimeFixture(t);
  const completion = f.load("lib/analysis-worker.ts").parseCompletionPayload({
    workerId: "contract-worker", version: 1, resultKey: "contract-result-0001",
    analysis: { schemaVersion: "analysis.v10", report, confidence: 80 },
  });
  assert.ok(completion);
  assert.equal(JSON.parse(completion.analysis.reportJson).content_analysis.evidence_registry.find(row => row.id === "ocr:0001").text, generated.raw);
});

test("raw evidence accepts dense Unicode while generated text retains its own limit", () => {
  const content = contentAnalysisFixture();
  const source = "  原始文字😀\n" + "😀".repeat(1500) + "  ";
  content.evidence_registry.push({ id: "ocr:0001", source: "ocr", text: source, start_ms: 0, end_ms: 0, asset_ref: null, frame_group_id: null });
  const parsed = readVideoContentAnalysis(content);
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.value.evidence_registry.at(-1).text, source);
  content.segments.push({ id: "oversized-event", kind: "hook_first_sentence", dimension_id: null, tags: [], start_ms: 0, end_ms: 1000, text: "😀".repeat(1001), evidence_ids: ["transcript:0001"] });
  assert.equal(readVideoContentAnalysis(content).status, "invalid");
});

test("the total report budget still rejects oversized evidence and completion payloads", t => {
  const content = contentAnalysisFixture();
  content.evidence_registry[0].text = "😀".repeat(CONTENT_REPORT_MAX_UTF16_UNITS / 2);
  const read = readVideoContentAnalysis(content);
  assert.equal(read.status, "invalid");
  assert.match(read.issues.join(" "), /报告体积/);
  const f = runtimeFixture(t);
  assert.equal(f.load("lib/analysis-worker.ts").parseCompletionPayload({
    workerId: "contract-worker", version: 1, resultKey: "contract-result-0001",
    analysis: { schemaVersion: "analysis.v10", report: analysisReportFixture(content), confidence: 80 },
  }), null);
});
