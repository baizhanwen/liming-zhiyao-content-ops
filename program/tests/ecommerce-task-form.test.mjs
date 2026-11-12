import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { taskBriefSchema } from "../lib/ecommerce/contracts.ts";
import { copyTaskBriefForSubmission, initialTaskDraft } from "../lib/ecommerce/task-question-options.ts";

const root = fileURLToPath(new URL("..", import.meta.url)), packageRequire = createRequire(import.meta.url), cache = new Map();
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
    return load(/\.[cm]?[jt]sx?$/.test(target) ? target : existsSync(target + ".ts") ? target + ".ts" : target + ".tsx");
  };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  cache.set(filename, loaded.exports);
  return loaded.exports;
}
const { TaskForm } = load("components/ecommerce/TaskForm.tsx");
const render = row => renderToStaticMarkup(React.createElement(TaskForm, {
  scope: { organizationId: "test-org", projectId: "test-project" }, row,
  options: { products: [], knowledge: [], accounts: [], strategy: null }, methods: [], cases: [], references: [],
  enabled: true, dirty() {}, async saved() {}, discard: () => true,
}));

test("new task has one form and defaults to methodology writing without a required reference video", () => {
  const html = render();
  assert.equal(initialTaskDraft({ products: [] }).brief.referenceMode, "method");
  assert.match(html, /是否参考视频/);
  assert.match(html, /无需准备对标视频/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.doesNotMatch(html, /选择一个对标带货视频|去对标内容库|参考文案版本/);
  assert.doesNotMatch(html, /主要介绍的卖点|采用的卖点证据|选择.*方法卡/);
  assert.equal((html.match(/<form\b/g) ?? []).length, 1);
});

test("saved reference tasks restore the opted-in checkbox while historical method tasks need no video", () => {
  const brief = taskBriefSchema.parse({ audience: {}, benchmark: { referenceId: "saved-reference", analysisId: "saved-analysis", transcriptId: null } });
  const row = { title: "已有任务", product_version_id: "saved-product", brief_json: JSON.stringify(brief) };
  const benchmark = render(row);
  assert.match(benchmark, /type="checkbox"[^>]*checked/);
  assert.match(benchmark, /选择一个对标带货视频/);
  assert.match(benchmark, /来源待核对/);
  const method = render({ ...row, brief_json: JSON.stringify({ ...brief, referenceMode: "method" }) });
  assert.doesNotMatch(method, /type="checkbox"[^>]*checked|选择一个对标带货视频|正在读取所选视频/);
});

test("method submission excludes hidden references and manual selectors while preserving writing requirements", () => {
  const brief = taskBriefSchema.parse({ audience: { user: "轮班护士", buyer: "本人", status: "confirmed" }, referenceMode: "method",
    benchmark: { referenceId: "old-reference", analysisId: "old-analysis", transcriptId: null }, caseIds: ["old-case"],
    componentIds: ["old-method"], claimId: "old-claim", evidenceIds: ["old-evidence"], knowledgeIds: ["selected-brand"],
    scene: "夜班后整理随身物品", barrier: "担心不适合自己", target: "live_entry", durationSec: 60,
    destination: "进入直播间核对适用条件", instructions: "用自然口语", excludedConditions: ["不编造体验"],
  });
  const submitted = copyTaskBriefForSubmission(brief);
  assert.equal(submitted.referenceMode, "method");
  assert.equal(submitted.benchmark, null);
  assert.equal(submitted.claimId, "");
  for (const field of ["caseIds", "componentIds", "evidenceIds"]) assert.deepEqual(submitted[field], []);
  for (const field of ["audience", "scene", "barrier", "target", "durationSec", "destination", "instructions", "knowledgeIds", "excludedConditions"]) assert.deepEqual(submitted[field], brief[field]);
  assert.equal(brief.benchmark.referenceId, "old-reference", "Preparing a submission does not mutate the saved task");
});

test("reference submission retains exactly the selected reference source", () => {
  const direct = taskBriefSchema.parse({ audience: {}, referenceMode: "benchmark", benchmark: { referenceId: "chosen-reference", analysisId: "chosen-analysis" }, caseIds: ["stale-case"] });
  const submitted = copyTaskBriefForSubmission(direct);
  assert.deepEqual(submitted.benchmark, direct.benchmark);
  assert.deepEqual(submitted.caseIds, []);
  const profile = copyTaskBriefForSubmission({ ...direct, benchmark: null, caseIds: ["chosen-case", "stale-case"] });
  assert.equal(profile.benchmark, null);
  assert.deepEqual(profile.caseIds, ["chosen-case"]);
});

const { Assembly } = load("components/ecommerce/Assembly.tsx");
function manuscriptHtml(editorialReview) {
  const brief = taskBriefSchema.parse({ audience: {}, referenceMode: "method", durationSec: 45 });
  const pack = { title: "买课之前，先确认自己会不会动手", target: "product_click", pendingConfirmations: [], applications: [], segments: [
    { id: "h", role: "hook", script: "先别急着买课，想想你手上有没有一个要解决的问题。", durationSec: 8, componentIds: [], claimIds: [], evidenceIds: [], knowledgeIds: [], caseIds: [] },
    { id: "e", role: "evidence", script: "这门课程用一份真实需求，把操作步骤和练习连起来。", durationSec: 28, componentIds: [], claimIds: [], evidenceIds: [], knowledgeIds: [], caseIds: [] },
    { id: "c", role: "cta", script: "先看第一节的练习安排，再判断是否适合你。", durationSec: 9, componentIds: [], claimIds: [], evidenceIds: [], knowledgeIds: [], caseIds: [] },
  ] };
  const version = { id: "v1", version: 1, mode: "ai", created_at: "2026-11-12T06:00:00Z", change_summary: "完整生成", product_version_id: "p1", pack_json: JSON.stringify(pack), source_manifest_json: "[]", validation_json: JSON.stringify({ ok: true, ...(editorialReview ? { review: { editorialReview } } : {}) }), input_snapshot_json: JSON.stringify({ task: { brief }, sources: [{ type: "claim", id: "claim", title: "SECRET_SOURCE_TITLE", text: "RAW_SOURCE_INTERNAL_DETAILS" }], product: { name: "练习课程" }, plan: { copyDirection: { hook: "METHOD_REASON_NOT_MAIN_COPY", bridge: "", proof: "", cta: "", referenceAdaptation: "" } } }) };
  return renderToStaticMarkup(React.createElement(Assembly, { scope: { organizationId: "test-org", projectId: "test-project" }, detail: { task: { id: "task", revision: 1, current_version: 1, status: "draft" }, versions: [version], reviews: [], runs: [], publications: [] }, enabled: true, dirty() {}, async changed() {}, async replace() {} }));
}

test("manuscript opens as continuous readable copy with copy action and keeps evidence and rewrite controls secondary", () => {
  const html = manuscriptHtml();
  assert.match(html, /完整口播文案/);
  assert.match(html, /复制全文/);
  assert.match(html, /45 秒/);
  assert.match(html, /先别急着买课/);
  assert.match(html, /这门课程用一份真实需求/);
  assert.match(html, /先看第一节的练习安排/);
  assert.doesNotMatch(html, /本段事实与方法依据|只替换开头|RAW_SOURCE_INTERNAL_DETAILS|SECRET_SOURCE_TITLE|METHOD_REASON_NOT_MAIN_COPY/);
  assert.match(html, /历史草稿 · 尚未进行新版内容校对/);
});

test("only a saved editorial review marks a manuscript as reviewed and keeps the human confirmation boundary", () => {
  const html = manuscriptHtml({ verdict: "usable", summary: "说明了具体练习方式", checks: [], missingFacts: [] });
  assert.match(html, /已完成内容校对 · 发布前仍需确认/);
  assert.doesNotMatch(html, /历史草稿/);
  assert.doesNotMatch(html, /质量优秀|可直接发布|保证转化/);
});
