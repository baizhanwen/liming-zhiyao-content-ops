import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { contentAnalysisFixture, contentTaxonomyFixture } from "./helpers/content-analysis-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageRequire = createRequire(import.meta.url);
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const loaded = { exports: {} };
  const require = name => {
    if (!name.startsWith(".")) return packageRequire(name);
    const target = path.resolve(path.dirname(filename), name);
    if (name.endsWith(".json")) return { default: JSON.parse(readFileSync(target, "utf8")) };
    return load(/\.[cm]?[jt]sx?$/.test(target) ? target : target + ".ts");
  };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  cache.set(filename, loaded.exports);
  return loaded.exports;
}
const presentation = load("lib/content-analysis-presentation.ts");
const { ContentAnalysisPanel } = load("components/ContentAnalysisPanel.tsx");

test("legacy and malformed reports retain distinct, honest upgrade states", () => {
  const legacy = renderToStaticMarkup(React.createElement(ContentAnalysisPanel, { report: { summary: "旧报告保留" } }));
  assert.match(legacy, /尚未生成标准分类/);
  assert.doesNotMatch(legacy, /分类已完成/);
  const invalid = renderToStaticMarkup(React.createElement(ContentAnalysisPanel, { report: { content_analysis: { schema_version: "bad" } } }));
  assert.match(invalid, /标准分类需要核对/);
});

test("report display keeps unknown separate from absence and only links owned frame assets", () => {
  const content = contentAnalysisFixture();
  content.evidence_registry.push({ id: "frame:0001", source: "frame", text: "保留的首帧画面", start_ms: 0, end_ms: 0, asset_ref: "owned-frame", frame_group_id: null });
  const html = renderToStaticMarkup(React.createElement(ContentAnalysisPanel, { report: { content_analysis: content }, assets: [{ id: "owned-frame", url: "/private/synthetic-frame" }] }));
  assert.match(html, /无法判断/);
  assert.doesNotMatch(html, /确认未出现/);
  assert.match(html, /首帧与前3秒/);
  assert.match(html, /src="\/private\/synthetic-frame"/);
  assert.match(html, /转写字符／全片秒/);
  const inaccessible = renderToStaticMarkup(React.createElement(ContentAnalysisPanel, { report: { content_analysis: content } }));
  assert.doesNotMatch(inaccessible, /src="/);
});

test("export includes missing states, measured metrics, annotations and evidence instead of inferred zeroes", () => {
  const content = contentAnalysisFixture();
  const text = presentation.contentAnalysisMarkdown(content);
  assert.match(text, /video-taxonomy.v1/);
  assert.match(text, /无法判断/);
  assert.match(text, /检测切换次数：未取得/);
  assert.match(text, /transcript:0001/);
  assert.doesNotMatch(text, /检测切换次数：0/);
  assert.equal(presentation.contentTimeLabel(1_250), "00:01.250");
  assert.equal(presentation.contentTimeLabel(null), "时间未确定");
  assert.match(presentation.contentReasonLabel("information_units_not_identified"), /信息单元/);
});

test("preflight classification ceilings include every module and bounded retry from the shared contract", () => {
  const { estimateContentClassificationMaximumTokens, estimateAnalysisMaximumTokens, analysisProfileBudgets } = load("lib/analysis-profile.ts");
  for (const profile of ["standard", "max"]) {
    const budget = contentTaxonomyFixture.budgets[profile];
    const expected = budget.max_api_attempts_per_module * (Object.keys(budget.modules).length * budget.input_token_limit + Object.values(budget.modules).reduce((a, b) => a + b, 0));
    assert.equal(estimateContentClassificationMaximumTokens(profile), expected);
    const legacy = analysisProfileBudgets[profile];
    assert.equal(estimateAnalysisMaximumTokens(60, profile), expected + legacy.sourceTokens + legacy.promptTokens + legacy.outputTokens);
    assert.ok(estimateAnalysisMaximumTokens(3_600, profile) > estimateAnalysisMaximumTokens(60, profile));
  }
});
