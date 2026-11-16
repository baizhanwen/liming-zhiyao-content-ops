import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

function historicalPartialReport() {
  const report = unifiedAnalysisReportFixture(), content = report.content_analysis, unified = report.unified_report;
  Object.assign(report.analysis_meta, { contract_version: "analysis.v12", transcript_review_enabled: false, transcript_source_kind: "asr" });
  report.analysis_meta.quality_audit = { status: "review", acceptance_passed: false, completion_status: "partial", issues: ["text_expression_value:length"] };
  content.status = unified.status = "partial";
  content.validation = unified.validation = { passed: false, issues: ["text_expression_value:length"] };
  Object.assign(content.module_status.text_expression_value, { status: "failed", reason: "length", validation: { passed: false, issues: [] } });
  Object.assign(unified.sections[1], { status: "failed", reason: "length", findings: [] });
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

function handler(file, name, bindings) {
  const filename = new URL(`../${file}`, import.meta.url);
  const source = ts.createSourceFile(filename.pathname, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node; ts.forEachChild(node, visit); };
  visit(source); assert.ok(declaration, name);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code}\nreturn ${name};`)(...Object.values(bindings));
}

function workspaceRetry({ response, refreshError = false } = {}) {
  const requests = [], errors = [], feedback = {}, pendingJobActions = { current: new Set() };
  const taskReader = { current: { reader: { invalidate() {} } } };
  let selectedJob = "";
  const retry = handler("components/AnalysisWorkspace.tsx", "retry", {
    pendingJobActions, taskReader, organizationId: "org", projectId: "project",
    setError: value => errors.push(value), setJobActionId: value => { selectedJob = typeof value === "function" ? value(selectedJob) : value; },
    setJobFeedback: change => { const next = { ...change(feedback) }; for (const key of Object.keys(feedback)) delete feedback[key]; Object.assign(feedback, next); },
    setJobs() {}, setTaskSnapshotTimes() {},
    scopedFetch: async (url, init) => { requests.push({ url, init }); return await response(); },
    readError: async response => (await response.json()).error.message,
    loadVideos: async () => { if (refreshError) throw new Error("synthetic refresh failure"); },
  });
  return { retry, requests, errors, feedback, pendingJobActions, taskReader, selectedJob: () => selectedJob };
}

test("checkpoint recovery has immediate feedback and prevents duplicate pending submissions", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = workspaceRetry({ response: () => pending });
  const first = f.retry("saved-job");
  assert.equal(f.feedback["saved-job"].tone, "pending");
  assert.match(f.feedback["saved-job"].message, /正在提交/);
  await f.retry("saved-job"); assert.equal(f.requests.length, 1);
  release(Response.json({ job: { id: "saved-job", status: "pending" } })); await first;
  assert.equal(f.feedback["saved-job"], undefined, "Confirmed recovery removes the pending indicator without adding a persistent success box");
  assert.equal(f.requests[0].url, "/api/analysis-jobs/saved-job/retry");
  assert.equal(f.requests[0].init.body, undefined, "The API chooses incomplete modules from the saved checkpoint");
  assert.equal(f.selectedJob(), ""); assert.equal(f.pendingJobActions.current.size, 0);
});

test("checkpoint rejection remains visible next to the job and preserves the server reason", async () => {
  const f = workspaceRetry({ response: async () => Response.json({ error: { message: "当前模块检查点不可复用，请刷新报告。" } }, { status: 409 }) });
  await f.retry("saved-job");
  assert.equal(f.feedback["saved-job"].tone, "error");
  assert.equal(f.feedback["saved-job"].message, "当前模块检查点不可复用，请刷新报告。");
  assert.equal(f.errors.at(-1), f.feedback["saved-job"].message);
});

test("accepted recovery with a failed refresh does not tell the user to submit again", async () => {
  const f = workspaceRetry({ response: async () => Response.json({ job: { id: "saved-job", status: "pending" } }), refreshError: true });
  await f.retry("saved-job");
  assert.match(f.feedback["saved-job"].message, /已受理.*刷新失败.*不必再次提交/);
  assert.equal(f.requests.length, 1);
});

test("an uncertain recovery request reports the network error and asks for a status check", async () => {
  const f = workspaceRetry({ response: async () => { throw new Error("合成网络中断"); } });
  await f.retry("saved-job");
  assert.equal(f.feedback["saved-job"].tone, "error");
  assert.match(f.feedback["saved-job"].message, /合成网络中断.*刷新任务状态核对/);
});

test("module recovery reports pending, acceptance and explicit rejection without changing mode or sampling", async () => {
  for (const ok of [true, false]) {
    const feedback = [], requests = [], notices = [];
    const retry = handler("components/AnalysisDetail.tsx", "retryModule", {
      detail: { job: { id: "saved-job" } }, canRetry: true, requestUrl: "selected-report", organizationId: "org", projectId: "project",
      setModuleFeedback: value => feedback.push(value), setNotice: value => notices.push(value), setSnapshot() {}, runAction: async (_name, work) => { try { await work(); } catch {} },
      readApiError: async response => (await response.json()).error.message,
      scopedFetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return ok ? Response.json({ job: { id: "saved-job" } }) : Response.json({ error: { message: "合成检查点冲突" } }, { status: 409 }); },
    });
    await retry("text_expression_value");
    assert.equal(feedback[0].tone, "pending"); assert.equal(feedback.at(-1).tone, ok ? "success" : "error");
    assert.match(feedback.at(-1).message, ok ? /已受理.*等待主机/ : /合成检查点冲突/);
    assert.deepEqual(notices, [], "Module recovery does not add a long global success notice");
    assert.deepEqual(requests[0].body.moduleKeys, ["text_expression_value"]);
    assert.equal("visualAnalysisMode" in requests[0].body, false); assert.equal("visualSamplingLevel" in requests[0].body, false);
  }
});

test("normalized historical partial reports retain completed content and display the true failed module", t => {
  const f = runtimeFixture(t), report = historicalPartialReport();
  const view = f.load("lib/analysis-report-view.ts").analysisReportView("analysis.v12", report);
  assert.equal(view.invalid, false); assert.equal(view.sections.filter(section => section.status === "completed").length, 3);
  const { reportRecoverySummary } = f.load("lib/analysis-recovery-view.ts");
  const summary = reportRecoverySummary(view);
  assert.match(summary, /已保留 3 个完成部分.*文案、价值与行动.*模型输出没有完整返回/);
  assert.doesNotMatch(summary, /注册表|重复的证据引用/);
  assert.equal(reportRecoverySummary({ ...view, invalid: true }), null, "Invalid evidence must not be presented as recovered content");
  const root = fileURLToPath(new URL("../", import.meta.url)), cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const loaded = { exports: {} }, code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function("require", "module", "exports", code)(name => {
      if (name === "react") return React; if (name === "react/jsx-runtime") return jsx;
      const target = path.resolve(path.dirname(filename), name);
      return target.startsWith(path.join(root, "components")) ? load(target + ".tsx") : f.load(target + ".ts");
    }, loaded, loaded.exports);
    cache.set(filename, loaded.exports); return loaded.exports;
  }
  const { UnifiedReportContent } = load(path.join(root, "components/UnifiedReportContent.tsx"));
  for (const tone of ["pending", "error"]) {
    const html = renderToStaticMarkup(React.createElement(UnifiedReportContent, { view, assets: [], canLocate: false, onLocate() {}, onCopyScript() {}, canCopyScript: true,
      failedModuleKeys: ["text_expression_value"], onRetry() {}, busy: tone === "pending", retryFeedback: { module: "text_expression_value", tone, message: `合成恢复反馈-${tone}` } }));
    assert.match(html, /report-text_topic_structure_audience/); assert.match(html, /report-visual/); assert.match(html, /report-synthesis/);
    assert.match(html, new RegExp(`合成恢复反馈-${tone}`));
    assert.match(html, tone === "error" ? /role="alert"/ : /role="status"/);
    assert.match(html, tone === "pending" ? /正在提交恢复/ : /只补这一部分/);
  }
});
