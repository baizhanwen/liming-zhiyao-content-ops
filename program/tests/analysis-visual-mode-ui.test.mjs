import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
function loadFunction(file, name, bindings) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(declaration, `${name} must exist`);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code}\nreturn ${name};`)(...Object.values(bindings));
}
const compiledHelper = ts.transpileModule(read("lib/visual-analysis-mode.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helper = { exports: {} };
new Function("exports", compiledHelper)(helper.exports);
const recordedMode = loadFunction("components/AnalysisDetail.tsx", "recordedVisualAnalysisMode", helper.exports);
const samplingHelper = { exports: {} };
new Function("exports", ts.transpileModule(read("lib/visual-sampling-level.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(samplingHelper.exports);
const recordedSamplingLevel = loadFunction("components/AnalysisDetail.tsx", "recordedVisualSamplingLevel", samplingHelper.exports);

test("history mode follows the selected report, never a newer job", () => {
  const job = { id: "new-job", visual_analysis_mode: "vision_only" };
  const history = { id: "old-report", analysis_job_id: "old-job", report: {} };
  assert.equal(recordedMode(history, job), "hybrid");
  history.report = { analysis_meta: { visual_analysis_mode: "hybrid" } };
  assert.equal(recordedMode(history, { id: "old-job", visual_analysis_mode: "vision_only" }), "hybrid");
  history.report.analysis_meta.visual_analysis_mode = "vision_only";
  assert.equal(recordedMode(history, { id: "old-job", visual_analysis_mode: "hybrid" }), "vision_only");
  assert.equal(recordedMode({ ...history, report: {} }, { id: "old-job", visual_analysis_mode: "vision_only" }), "vision_only");
  assert.equal(recordedMode(null, job), "vision_only");
});

test("historical sampling stays historical while saved sampling follows the selected report", () => {
  const history = { id: "old-report", analysis_job_id: "old-job", report: {} };
  assert.equal(recordedSamplingLevel(history, { id: "new-job", visual_sampling_level: "detailed" }), null);
  assert.equal(recordedSamplingLevel(history, { id: "old-job", visual_sampling_level: null }), null);
  history.report = { analysis_meta: { visual_sampling_level: "quick" } };
  assert.equal(recordedSamplingLevel(history, { id: "old-job", visual_sampling_level: "detailed" }), "quick");
  history.report.analysis_meta.visual_sampling_level = null;
  assert.equal(recordedSamplingLevel(history, { id: "old-job", visual_sampling_level: "detailed" }), null);
  assert.equal(recordedSamplingLevel(null, { id: "pending-job", visual_sampling_level: "balanced" }), "balanced");
});

test("module retry preserves saved visual settings rather than applying the new-analysis selectors", async () => {
  const requests = [];
  const retry = loadFunction("components/AnalysisDetail.tsx", "retryModule", {
    detail: { job: { id: "saved-job" } }, canRetry: true,
    organizationId: "synthetic-org", projectId: "synthetic-project", visualAnalysisMode: "vision_only", visualSamplingLevel: "detailed",
    runAction: async (_name, work) => work(), setNotice() {}, setModuleFeedback() {}, requestUrl: "synthetic-report-url",
    scopedFetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return Response.json({}); },
    readApiError: async () => "error",
  });
  await retry("visual");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.moduleKeys, ["visual"]);
  assert.equal("visualAnalysisMode" in requests[0].body, false);
  assert.equal("visualSamplingLevel" in requests[0].body, false);
});

for (const visualAnalysisMode of ["hybrid", "vision_only"]) for (const visualSamplingLevel of ["quick", "balanced", "detailed"]) {
  test(`URL creation carries ${visualAnalysisMode}/${visualSamplingLevel} independently of transcript review`, async () => {
    const requests = [];
    const bindings = {
      organizationId: "synthetic-org", projectId: "synthetic-project", analysisProfile: "max", transcriptReviewEnabled: true, visualAnalysisMode, visualSamplingLevel,
      setSubmitting() {}, setError() {}, setSubmitMessage() {}, setTranscriptReviewEnabled() {},
      taskReader: { current: { reader: { invalidate() {} } } },
      FormData: class { get(name) { return name === "url" ? "https://v.douyin.com/synthetic/" : "合成备注"; } },
      scopedFetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return Response.json({ video: { id: "video" }, job: { id: "job" } }, { status: 201 }); },
      readError: async () => "error", appendCreated() {}, loadVideos: async () => {},
    };
    await loadFunction("components/AnalysisWorkspace.tsx", "submitUrl", bindings)({ preventDefault() {}, currentTarget: { reset() {} } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.visualAnalysisMode, visualAnalysisMode);
    assert.equal(requests[0].body.visualSamplingLevel, visualSamplingLevel);
    assert.equal(requests[0].body.transcriptReviewEnabled, true);
  });

  test(`batch upload carries ${visualAnalysisMode}/${visualSamplingLevel} for every file`, async () => {
    const requests = [];
    const bindings = {
      organizationId: "synthetic-org", projectId: "synthetic-project", analysisProfile: "standard", visualAnalysisMode, visualSamplingLevel,
      setSubmitting() {}, setError() {}, setUploadProgress() {}, setUploadEstimates() {},
      taskReader: { current: { reader: { invalidate() {} } } },
      scopedFetch: async (url, init) => { requests.push({ url, mode: init.body.get("visualAnalysisMode"), samplingLevel: init.body.get("visualSamplingLevel") }); return Response.json({ video: { id: "video" }, job: { id: "job" } }); },
      readError: async () => "error", appendCreated() {}, loadVideos: async () => {},
    };
    await loadFunction("components/AnalysisWorkspace.tsx", "uploadFile", bindings)({ preventDefault() {}, currentTarget: {
      elements: { namedItem: () => ({ files: [new File(["a"], "first.mp4"), new File(["b"], "second.mp4")] }) }, reset() {},
    } });
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.mode === visualAnalysisMode));
    assert.ok(requests.every(request => request.samplingLevel === visualSamplingLevel));
  });

  test(`reanalyze and manual-transcript reanalysis carry ${visualAnalysisMode}/${visualSamplingLevel}`, async () => {
    const requests = [];
    const bindings = {
      organizationId: "synthetic-org", projectId: "synthetic-project", videoId: "video", profile: "max", visualAnalysisMode, visualSamplingLevel,
      draft: [{ startMs: 0, endMs: 1000, text: "合成原文" }], detail: { transcript: { language: "zh-CN" } },
      setSelectedId() {}, setNotice() {}, setEditing() {}, runAction: async (_name, work) => work(),
      scopedFetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return Response.json({}); },
      readApiError: async () => "error",
    };
    await loadFunction("components/AnalysisDetail.tsx", "reanalyze", bindings)();
    await loadFunction("components/AnalysisDetail.tsx", "saveTranscript", bindings)(true);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.body.visualAnalysisMode === visualAnalysisMode));
    assert.ok(requests.every(request => request.body.visualSamplingLevel === visualSamplingLevel));
    assert.equal(requests[1].body.reanalyze, true);
  });
}

test("the selector states the pure-vision boundary and disables edits while submitting", () => {
  const source = ts.transpileModule(read("components/VisualAnalysisModeSelect.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(name => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsx;
    throw new Error("Unexpected dependency: " + name);
  }, loaded, loaded.exports);
  const html = renderToStaticMarkup(React.createElement(loaded.exports.VisualAnalysisModeSelect, { value: "vision_only", onChange() {}, disabled: true }));
  assert.match(html, /value="vision_only" selected=""/);
  assert.match(html, /disabled=""/);
  assert.match(html, /不运行本地 OCR/);
  assert.match(html, /口播转写照常/);
  assert.match(html, /需要可用的视觉模型/);
  const compact = renderToStaticMarkup(React.createElement(loaded.exports.VisualAnalysisModeSelect, { value: "vision_only", onChange() {}, compact: true }));
  assert.match(compact, /analysis-visual-mode-compact/);
  assert.match(compact, /aria-label="画面分析方式"/);
  assert.match(compact, /class="sr-only"/);
  const describedBy = compact.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy && compact.includes(`id="${describedBy}"`), "Compact mode retains its accessible description");
});

test("quick sampling remains an analysis tier and its compact selector keeps the description accessible", () => {
  const source = ts.transpileModule(read("components/VisualSamplingLevelSelect.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(name => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "../lib/visual-sampling-level") return samplingHelper.exports;
    throw new Error("Unexpected dependency: " + name);
  }, loaded, loaded.exports);
  const html = renderToStaticMarkup(React.createElement(loaded.exports.VisualSamplingLevelSelect, { value: "quick", onChange() {}, disabled: true, compact: true }));
  assert.match(html, /value="quick" selected=""/);
  assert.match(html, /disabled=""/);
  assert.match(html, /仍执行完整画面分析模块并保留关键取证/);
  assert.match(html, /aria-label="画面档位"/);
  const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy && html.includes(`id="${describedBy}"`));
});
