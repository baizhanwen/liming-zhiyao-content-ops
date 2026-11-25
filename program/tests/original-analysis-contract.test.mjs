import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const original = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-original.json", import.meta.url), "utf8"));
const reviewed = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v12.json", import.meta.url), "utf8"));

test("actual Python original-mode report passes the Web gate without claiming verified text", t => {
  const f = runtimeFixture(t), quality = f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v12", original);
  assert.equal(quality.accepted, true, JSON.stringify(quality.issues));
  assert.equal(quality.manuscriptStatus, "original");
  assert.equal(quality.reviewSegmentCount, 0);
  const view = f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", original);
  assert.equal(view.invalid, false);
  assert.equal(view.scriptStatus, "original");
  assert.equal(view.reviews.length, 0);
  assert.match(f.load("lib/analysis-report-view.ts").unifiedReportMarkdown("合成视频", view), /原始转写.*未启用自动校对/s);
  assert.match(f.load("lib/analysis-quality.ts").analysisCompletionMessage("analysis.v12", original), /原始转写/);
});

for (const [name, mutate] of [
  ["changed source text", report => { report.unified_report.canonical.segments[0].text += "错误新增内容"; }],
  ["a correction candidate", report => { report.unified_report.canonical.segments[0].candidate_text = "偷偷放入候选"; }],
  ["rewritten displayed paragraphs", report => { report.unified_report.canonical.paragraphs[0] += "偷偷改写的展示稿"; }],
  ["a verified segment label", report => { report.unified_report.canonical.segments[0].review_status = "accepted"; }],
  ["a verified outcome label", report => { report.unified_report.outcome.manuscript = "verified"; }],
  ["a conflicting analysis basis", report => { report.content_analysis.methodology.transcript_basis = "canonical"; }],
  ["missing recorded user choice", report => { delete report.analysis_meta.transcript_review_enabled; }],
]) test(`original mode rejects ${name}`, t => {
  const f = runtimeFixture(t), report = structuredClone(original); mutate(report);
  assert.equal(f.load("lib/analysis-quality.ts").assessAnalysisQuality("analysis.v12", report).accepted, false);
});

test("ordinary creation and single benchmark rewrite receive the complete original with truthful provenance", t => {
  const f = runtimeFixture(t), raw = original.unified_report.canonical.segments.map(row => row.original_text);
  const safe = f.load("lib/unified-report.ts").projectSafeAnalysisReport(original);
  assert.deepEqual(safe.spoken_script, raw);
  assert.equal(safe.review_coverage.manuscript, "original");
  const source = f.load("lib/content-production.ts").analysisReportSourceText(JSON.stringify(original));
  assert.match(source, /原始转写（未自动校对）/);
  assert.doesNotMatch(source, /仅采用已核对|经校正原版口播/);
  const rewrite = f.load("lib/single-benchmark-rewrite.ts").readBenchmarkRewriteSource(JSON.stringify(original));
  assert.equal(rewrite.sourceKind, "transcript");
  assert.equal(rewrite.sourceScript, raw.join("\n\n").trim());
  assert.equal(f.load("lib/single-benchmark-rewrite.ts").readBenchmarkRewriteSource(JSON.stringify(reviewed)), null);
  assert.equal(f.load("lib/video-content-analysis.ts").contentReviewCoverage(original.content_analysis), "original");
});

function loadReportComponent(f) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const componentsRoot = path.join(root, "components") + path.sep;
  const components = new Map();
  function load(filename) {
    if (components.has(filename)) return components.get(filename);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const loaded = { exports: {} };
    const require = name => {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return jsx;
      const target = path.resolve(path.dirname(filename), name);
      if (name.startsWith(".") && target.startsWith(componentsRoot)) return load(target + ".tsx");
      if (name.startsWith(".")) return f.load(target + ".ts");
      throw new Error("Unexpected component dependency: " + name);
    };
    new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
    components.set(filename, loaded.exports);
    return loaded.exports;
  }
  return load(path.join(root, "components/UnifiedReportContent.tsx")).UnifiedReportContent;
}

test("independent saved manuscript keeps candidate reasons, timestamp and per-sentence retry visible", t => {
  const f = runtimeFixture(t), Component = loadReportComponent(f);
  const report = structuredClone(reviewed);
  report.unified_report.canonical.segments.find(row => row.review_status === "needs_review").candidate_text = "待确认的候选文案";
  const view = f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", report);
  const html = renderToStaticMarkup(React.createElement(Component, {
    view, assets: [], canLocate: true, onLocate() {}, onCopyScript() {}, canCopyScript: true,
    failedModuleKeys: ["canonical"], onRetry() {}, manuscript: React.createElement("section", null, "已保存完整原稿"),
  }));
  assert.match(html, /已保存完整原稿/);
  assert.match(html, /核对疑义句/);
  assert.match(html, /听原句/);
  assert.match(html, /只补这一句/);
  assert.match(html, /未采用的候选/);
  assert.ok(html.includes(view.reviews[0].original));
});

test("original-mode manuscript displays the text without an empty review card", t => {
  const f = runtimeFixture(t), Component = loadReportComponent(f);
  const view = f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", original);
  const html = renderToStaticMarkup(React.createElement(Component, {
    view, assets: [], canLocate: false, onLocate() {}, onCopyScript() {}, canCopyScript: true,
    failedModuleKeys: [], manuscript: React.createElement("section", null, "原始ASR正文"),
  }));
  assert.match(html, /原始ASR正文/);
  assert.doesNotMatch(html, /report-script-review|未启用自动校对或生成纠错候选|核对疑义句|只补这一句/);
});

test("completion saves an original report only for a task that requested original text", async t => {
  const f = runtimeFixture(t), owner = await f.initialize();
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic-mode-token" } });
  f.mock("lib/video-knowledge-atoms.ts", { extractVideoKnowledgeAtoms: async () => ({ status: "completed" }) });
  f.mock("lib/benchmark-memory-events.ts", { enqueueBenchmarkVideoAnalysisMemoryEventsWithDb: async () => {} });
  const now = new Date().toISOString(), projectId = crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(projectId, owner.organizationId, "Synthetic", "Synthetic", owner.userId, owner.userId, now, now);
  const post = f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST;
  for (const enabled of [false, true]) {
    const videoId = crypto.randomUUID(), jobId = crypto.randomUUID();
    f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'upload','upload',?,?,?,?)")
      .run(videoId, owner.organizationId, projectId, owner.userId, owner.userId, now, now);
    f.sqlite.prepare("INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,lease_owner,lease_expires_at,transcript_review_enabled,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'upload',?,?,'analyzing','mode-worker',?,?,?,?,?,?)")
      .run(jobId, owner.organizationId, projectId, videoId, "synthetic-asset", jobId, new Date(Date.now() + 300_000).toISOString(), enabled ? 1 : 0, owner.userId, owner.userId, now, now);
    const response = await post(new Request("http://localhost/complete", {
      method: "POST", headers: { authorization: "Bearer synthetic-mode-token" }, body: JSON.stringify({
        workerId: "mode-worker", version: 0, resultKey: "original:" + jobId,
        analysis: { schemaVersion: "analysis.v12", confidence: null, report: original },
      }),
    }), { params: Promise.resolve({ jobId }) });
    assert.equal(response.status, enabled ? 409 : 200, await response.clone().text());
    assert.equal(f.sqlite.prepare("SELECT status FROM analysis_jobs WHERE id=?").get(jobId).status, enabled ? "analyzing" : "completed");
  }
});
