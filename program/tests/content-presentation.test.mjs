import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { contentAnalysisFixture, contentTaxonomyFixture, unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

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
    return load(/\.[cm]?[jt]sx?$/.test(target) ? target : existsSync(target + ".ts") ? target + ".ts" : target + ".tsx");
  };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  cache.set(filename, loaded.exports);
  return loaded.exports;
}
const presentation = load("lib/content-analysis-presentation.ts");
const { analysisReportView, unifiedReportMarkdown } = load("lib/analysis-report-view.ts");
const { UnifiedReportContent } = load("components/UnifiedReportContent.tsx");
const produced = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v11.json", import.meta.url), "utf8"));
const render = (view, props = {}) => renderToStaticMarkup(React.createElement(UnifiedReportContent, {
  view, assets: [], canLocate: true, onLocate: () => {}, onCopyScript: () => {}, canCopyScript: view.scriptStatus === "completed", failedModuleKeys: [], ...props,
}));

test("actual v11 renders one four-module report with evidence and a copyable manuscript", () => {
  const report = structuredClone(produced);
  report.summary = "LEGACY_PARALLEL_REPORT_MUST_NOT_RENDER";
  report.hook_analysis = [report.summary]; report.risks = [report.summary];
  const view = analysisReportView("analysis.v11", report), html = render(view, { assets: [{ id: "synthetic_frame_1", url: "/private/synthetic-frame" }] });
  assert.equal(view.invalid, false); assert.equal(view.complete, true);
  assert.equal((html.match(/class="unified-report-section"/g) || []).length, 4);
  const summaryDuplicates = report.unified_report.sections.filter(section => section.key === "synthesis").flatMap(section => section.findings).filter(finding => finding.text.trim() === view.summary.trim());
  assert.equal(summaryDuplicates.length, 1, "The production fixture exercises the former duplicated summary");
  assert.equal((html.match(/class="report-finding"/g) || []).length, 15);
  assert.equal(html.split(view.summary).length - 1, 1, "Core conclusion must appear only once");
  assert.match(html.match(/<section class="report-overview">[\s\S]*?<\/section>/)?.[0] || "", /查看依据/);
  assert.equal((html.match(/id="report-script"/g) || []).length, 1);
  assert.match(html, /查看依据/); assert.match(html, /跳转播放/);
  assert.match(html, /复制口播稿/); assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>复制口播稿/);
  assert.doesNotMatch(html, /LEGACY_PARALLEL_REPORT|独立视觉模型|真实画面理解|OCR 只用于|自动质量验收|整体置信度|analysis-quality-audit|content-classification-grid/);
  assert.match(html, /src="\/private\/synthetic-frame"/);
  assert.doesNotMatch(render(view), /src="/);
  assert.doesNotMatch(render(view, { canLocate: false }), /跳转播放/);
});

test("the four modules expose named core classifications directly and keep the remaining taxonomy rows in disclosures", () => {
  const view = analysisReportView("analysis.v11", produced), html = render(view);
  assert.deepEqual(view.sections.map(section => section.classifications.filter(row => row.featured).length), [6, 6, 6, 4]);
  const rows = view.sections.flatMap(section => section.classifications);
  assert.equal(rows.length, 65); assert.equal(new Set(rows.map(row => row.dimensionId)).size, 65);
  assert.equal(rows.filter(row => !row.featured).length, 43);
  const visible = [...html.matchAll(/<div class="report-core-classifications">([\s\S]*?)<\/dl><\/div>/g)];
  assert.equal(visible.length, 4);
  for (const [index, section] of view.sections.entries()) {
    for (const row of section.classifications.filter(row => row.featured)) {
      assert.ok(visible[index][1].includes(`<dt>${row.label}</dt>`), row.dimensionId);
      assert.ok(visible[index][1].includes(row.tags[0]?.label ?? row.value), row.dimensionId);
    }
    assert.doesNotMatch(visible[index][1], /<details/);
  }
  assert.equal((html.match(/<details class="report-more-classifications">/g) || []).length, 3);
  assert.doesNotMatch(html, /report-section-tags|识别出的内容特征|content-dimension-card/);
});

test("classification values preserve primary labels, unknown, absent, unavailable and inapplicable as distinct states", () => {
  const report = structuredClone(produced), classifications = report.content_analysis.classifications;
  const hook = classifications.find(row => row.dimension_id === "hook.type");
  const hookDefinition = contentTaxonomyFixture.dimensions.find(row => row.id === hook.dimension_id);
  const tagIds = ["提问", "痛点直击"].map(label => hookDefinition.tags.find(tag => tag.label === label).id);
  Object.assign(hook, { state: "known", tags: tagIds, primary_tag: tagIds[0], reason: null, evidence_ids: ["transcript:0001"] });
  const change = (id, values) => Object.assign(classifications.find(row => row.dimension_id === id), values);
  change("value.actionability", { state: "unknown", tags: null, primary_tag: null, reason: "model_could_not_determine_from_available_evidence", evidence_ids: [] });
  change("value.repetition", { state: "known", tags: ["value.repetition.none"], primary_tag: null, reason: null, evidence_ids: ["transcript:0001"] });
  change("audience.stage", { state: "not_acquired", tags: null, primary_tag: null, reason: "required_evidence_not_available_for_classification", evidence_ids: [] });
  change("audience.context", { state: "not_applicable", tags: null, primary_tag: null, reason: "dimension_not_applicable_to_this_content", evidence_ids: [] });
  const view = analysisReportView("analysis.v11", report), rows = view.sections.flatMap(section => section.classifications), html = render(view);
  assert.equal(view.invalid, false);
  assert.deepEqual(rows.find(row => row.dimensionId === "hook.type").tags.map(tag => tag.primary), [true, false]);
  assert.match(html, /提问<small class="report-primary-tag">主<\/small>/);
  assert.equal(rows.find(row => row.dimensionId === "value.actionability").value, "无法判断");
  assert.equal(rows.find(row => row.dimensionId === "value.repetition").value, "无明显重复");
  assert.equal(rows.find(row => row.dimensionId === "audience.stage").value, "未取得所需材料");
  assert.equal(rows.find(row => row.dimensionId === "audience.context").value, "不适用");
  assert.match(html, /现有依据不足以确定这一项/);
  assert.doesNotMatch(html, /model_could_not_determine|required_evidence_not_available|dimension_not_applicable/);
  assert.match(unifiedReportMarkdown("合成分类", view), /可操作程度：无法判断/);
});

test("four failed modules render four actionable failures without 65 unknown cards or a fake absence", () => {
  const report = structuredClone(produced), content = report.content_analysis;
  report.unified_report.status = content.status = "partial";
  report.unified_report.validation = content.validation = { passed: false, issues: ["provider_error"] };
  for (const row of content.classifications) Object.assign(row, { state: "unknown", tags: null, primary_tag: null, reason: "classification_not_returned", evidence_ids: [] });
  for (const state of Object.values(content.module_status)) Object.assign(state, { status: "failed", reason: "classification_request_failed", validation: { passed: false, issues: ["classification_request_failed"] } });
  for (const section of report.unified_report.sections) {
    Object.assign(section, { status: "failed", reason: "classification_request_failed", findings: [] });
    Object.assign(section.diagnostics, { failure_kind: "overloaded", http_status: 429, total_tokens: null });
  }
  const view = analysisReportView("analysis.v11", report), html = render(view, { failedModuleKeys: view.sections.map(row => row.key), onRetry: () => {} });
  assert.equal(view.invalid, false); assert.equal(view.complete, false);
  assert.equal((html.match(/class="unified-report-section"/g) || []).length, 4);
  assert.equal((html.match(/模型服务暂时繁忙/g) || []).length, 4);
  assert.equal((html.match(/只补这一部分/g) || []).length, 4);
  assert.doesNotMatch(html, /无法判断|确认未出现|classification_not_returned|0 \/ 65|content-classification/);
  assert.equal((html.match(/class="report-finding"/g) || []).length, 0);
});

test("invalid v11 cannot inherit acceptance from its old audit", () => {
  const report = structuredClone(produced); delete report.unified_report;
  report.analysis_meta.quality_audit.acceptance_passed = true;
  const view = analysisReportView("analysis.v11", report);
  assert.equal(view.invalid, true); assert.equal(view.complete, false);
});

test("an upstream dependency failure is not presented as a model returning malformed content", () => {
  const report = unifiedAnalysisReportFixture();
  report.unified_report.status = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["synthesis:upstream_module_failed"] };
  Object.assign(report.content_analysis.module_status.synthesis, { status: "failed", reason: "upstream_module_failed", validation: { passed: false, issues: ["upstream_module_failed"] } });
  Object.assign(report.unified_report.sections[3], { status: "failed", reason: "upstream_module_failed", findings: [] });
  Object.assign(report.unified_report.sections[3].diagnostics, { failure_kind: "schema_invalid", attempts: 0 });
  const html = render(analysisReportView("analysis.v11", report));
  assert.match(html, /需要先完成前面的分析部分/);
  assert.doesNotMatch(html, /返回内容没有通过格式检查/);
});

test("a deliberately unrequested module is distinguished from a provider failure", () => {
  const report = unifiedAnalysisReportFixture();
  report.unified_report.status = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["visual:not_requested"] };
  Object.assign(report.content_analysis.module_status.visual, { status: "failed", reason: "not_requested", validation: { passed: false, issues: ["not_requested"] } });
  Object.assign(report.unified_report.sections[2], { status: "failed", reason: "not_requested", findings: [] });
  report.unified_report.sections[2].diagnostics.failure_kind = null;
  const html = render(analysisReportView("analysis.v11", report));
  assert.match(html, /本次没有重试这一部分/);
  assert.doesNotMatch(html, /模型调用未完成/);
});

test("failed canonical candidates remain reviewable but cannot be copied as an accepted manuscript", () => {
  const report = unifiedAnalysisReportFixture(), content = report.content_analysis;
  report.unified_report.status = content.status = "partial";
  report.unified_report.validation = content.validation = { passed: false, issues: ["canonical_failed"] };
  report.unified_report.canonical.status = "failed";
  report.unified_report.canonical.validation = { passed: false, issues: ["numeric_or_version_changed"] };
  report.unified_report.canonical.paragraphs = ["待核对候选：Opus 4.5"];
  Object.assign(report.unified_report.canonical.segments[0], { original_text: "原文版本Opus 5.5", text: "待核对候选：Opus 4.5" });
  content.evidence_registry[0].text = "原文版本Opus 5.5";
  report.unified_report.canonical.changes = [{ source_segment_id: "transcript:0001", before: "原文版本Opus 5.5", after: "待核对候选：Opus 4.5", evidence_ids: [] }];
  for (const state of Object.values(content.module_status)) Object.assign(state, { status: "failed", reason: "canonical_failed", validation: { passed: false, issues: ["canonical_failed"] } });
  for (const section of report.unified_report.sections) {
    Object.assign(section, { status: "failed", reason: "canonical_failed", findings: [] });
    section.diagnostics.failure_kind = "canonical_failed";
  }
  const view = analysisReportView("analysis.v11", report), html = render(view, { failedModuleKeys: ["canonical"], onRetry: () => {} });
  assert.equal(view.invalid, false); assert.equal(view.scriptStatus, "failed");
  assert.match(html, /待核对候选：Opus 4.5/); assert.match(html, /保留为候选稿/);
  assert.match(html, /<button[^>]*disabled[^>]*>复制口播稿/);
  assert.equal((html.match(/重新校正口播/g) || []).length, 1);
  assert.doesNotMatch(html, /只补这一部分/);
  const exported = unifiedReportMarkdown("合成失败候选", view);
  assert.match(exported, /部分内容尚未完成/); assert.match(exported, /待核对口播候选稿/);
  assert.doesNotMatch(exported, /## 完整口播稿/);
});

test("historical structured CTA remains inside the expression module with its actual quote evidence", () => {
  const report = { summary: "历史报告保留", cta_analysis: { present: true, items: [{ cta_type: "关注引导", target_action: "关注账号", handoff_path: "主页", evidence_text: "点击主页关注我", start_ms: 1000 }], overall_assessment: "结尾动作明确" }, evidence: [{ source: "asr", text: "点击主页关注我", start_ms: 1000 }] };
  const view = analysisReportView("analysis.v9", report), section = view.sections.find(row => row.key === "text_expression_value");
  assert.equal(view.legacy, true); assert.equal(view.invalid, false);
  assert.ok(section.findings.some(row => row.text.includes("关注账号") && row.evidenceIds.includes("legacy:1")));
  const html = render(view);
  assert.match(html, /目标动作：关注账号/); assert.match(html, /承接：主页/); assert.match(html, /点击主页关注我/); assert.match(html, /00:01 · 跳转播放/);
  const absent = analysisReportView("analysis.v9", { cta_analysis: { present: false, items: [] } });
  assert.match(absent.sections.find(row => row.key === "text_expression_value").findings[0].text, /明确记录未识别/);
});

test("the unified export carries the displayed conclusions and evidence, with unknown metrics kept distinct from zero", () => {
  const view = analysisReportView("analysis.v11", produced), text = unifiedReportMarkdown("合成报告", view);
  assert.match(text, /完整口播稿/); assert.match(text, /选题、结构与人群/); assert.match(text, /为什么开完会/);
  assert.match(text, /核心结论：合成证据支持的简短结论/);
  const unknown = contentAnalysisFixture(), rows = presentation.contentMetricRows(unknown);
  assert.equal(rows.find(([label]) => label === "检测切换次数")[1], "未取得");
  unknown.metrics.shot_detection.status = "measured"; unknown.metrics.shot_detection.detected_cut_count = 0;
  assert.equal(presentation.contentMetricRows(unknown).find(([label]) => label === "检测切换次数")[1], "0次");
  assert.equal(presentation.contentTimeLabel(1250), "00:01.250");
});

test("v11 preflight estimates canonical plus four compact modules and keeps image usage unknown", () => {
  const { estimateContentClassificationMaximumTokens, estimateAnalysisMaximumTokens, estimateUnifiedAnalysisBudget } = load("lib/analysis-profile.ts");
  for (const profile of ["standard", "max"]) {
    const budget = contentTaxonomyFixture.budgets[profile].compact;
    const expected = Object.entries(budget.modules).reduce((sum, [module, hardCap]) => {
      const initial = Math.min(hardCap, budget.initial_output_tokens_by_module[module] ?? budget.initial_output_tokens);
      return sum + budget.input_token_limit + initial + (initial < hardCap
        ? budget.input_token_limit + Math.min(hardCap, Math.max(initial + 1500, initial * 2)) : 0);
    }, 0);
    assert.equal(estimateContentClassificationMaximumTokens(profile), expected);
    const estimate = estimateUnifiedAnalysisBudget(60, profile);
    assert.equal(estimateAnalysisMaximumTokens(60, profile), expected + estimate.canonical.retryTokensEstimate);
    assert.equal(estimate.modules.length, 4);
    assert.equal(estimate.visualTokens, null); assert.equal(estimate.includesImageModelCalls, false);
    assert.equal(estimate.isHardCap, false); assert.equal(estimate.maximumRequestCount, profile === "max" ? 9 : 10);
    assert.ok(estimateAnalysisMaximumTokens(3_600, profile) > estimateAnalysisMaximumTokens(60, profile));
  }
});
