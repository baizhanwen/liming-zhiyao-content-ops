import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/analysis-profile.ts", import.meta.url), "utf8");
const taxonomy = JSON.parse(readFileSync(new URL("../services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json", import.meta.url), "utf8"));
function load(data = taxonomy) {
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)(() => ({ default: data }), loaded, loaded.exports);
  return loaded.exports;
}

test("fresh short media budgets exactly one canonical batch and four compact modules", () => {
  const { estimateUnifiedAnalysisBudget } = load();
  for (const [profile, initial, retried, output, expression, maximumCalls] of [
    ["standard", 46_500, 106_500, [3000, 6000], [4500, 6000], 10],
    ["max", 84_000, 156_000, [4500, 6000], [6000], 9],
  ]) {
    const estimate = estimateUnifiedAnalysisBudget(60, profile);
    assert.equal(estimate.pipelineVersion, "analysis.v12");
    assert.equal(estimate.canonical.batchCountEstimate, 1);
    assert.deepEqual(estimate.canonical.outputTokenBudgets, output);
    assert.equal(estimate.initialRequestCount, 5); assert.equal(estimate.maximumRequestCount, maximumCalls);
    assert.deepEqual(estimate.modules.map(row => row.key), taxonomy.modules);
    for (const row of estimate.modules) assert.deepEqual(row.outputTokenBudgets, row.key === "text_expression_value" ? expression : output);
    assert.equal(estimate.initialTextTokensEstimate, initial);
    assert.equal(estimate.retryTextTokensEstimate, retried);
    assert.equal(estimate.visualTokens, null); assert.equal(estimate.isHardCap, false);
  }
});

test("inputs are charged again for four modules and their potential retries", () => {
  const { estimateUnifiedAnalysisBudget } = load();
  const estimate = estimateUnifiedAnalysisBudget(60, "max");
  assert.equal(estimate.initialInputTokensEstimate, 5 * 12_000);
  assert.equal(estimate.retryInputTokensEstimate, 9 * 12_000);
  assert.equal(estimate.retryTextTokensEstimate - estimate.retryInputTokensEstimate, 4 * (4500 + 6000) + 6000);
  assert.equal(estimate.includesImageModelCalls, false);
  assert.ok(estimate.modules.some(row => row.key === "visual")); // This is a text-classification call, not an image-model bill.
});

test("configured caps prevent repeated module length attempts while preserving a bounded canonical repair", () => {
  const { estimateUnifiedAnalysisBudget } = load();
  const low = estimateUnifiedAnalysisBudget(60, "max", { maxOutputTokens: 2500 });
  assert.equal(low.maximumRequestCount, 6);
  assert.equal(low.retryTextTokensEstimate - low.initialTextTokensEstimate, 12_000 + 2500);
  assert.deepEqual(low.canonical.outputTokenBudgets, [2500, 2500]);
  assert.ok(low.modules.every(row => row.outputTokenBudgets.join() === "2500"));
  const high = estimateUnifiedAnalysisBudget(60, "max", { maxOutputTokens: 12_000 });
  assert.deepEqual(high.canonical.outputTokenBudgets, [4500, 9000]);
  for (const row of high.modules) assert.deepEqual(row.outputTokenBudgets, row.key === "text_expression_value" ? [6000] : [4500, 6000]);
  const bounded = estimateUnifiedAnalysisBudget(60, "max", { maxOutputTokens: 5000 });
  assert.deepEqual(bounded.modules.find(row => row.key === "text_expression_value").outputTokenBudgets, [5000]);
  assert.ok(bounded.modules.filter(row => row.key !== "text_expression_value").every(row => row.outputTokenBudgets.join() === "4500,5000"));
});

test("long media grows canonical batches, never legacy report passes or module count", () => {
  const { estimateUnifiedAnalysisBudget, estimateCanonicalBatchCount } = load();
  assert.equal(estimateCanonicalBatchCount(96), 1);
  assert.equal(estimateCanonicalBatchCount(96.01), 2);
  const actualShort = estimateUnifiedAnalysisBudget(114.816, "max");
  assert.equal(actualShort.canonical.batchCountEstimate, 2);
  assert.equal(actualShort.maximumRequestCount, 11);
  assert.equal(actualShort.retryTextTokensEstimate, 190_500);
  const short = estimateUnifiedAnalysisBudget(60, "max"), long = estimateUnifiedAnalysisBudget(3600, "max");
  assert.ok(long.canonical.batchCountEstimate > short.canonical.batchCountEstimate);
  assert.deepEqual(long.modules, short.modules);
  assert.equal(long.retryTextTokensEstimate - short.retryTextTokensEstimate,
    long.canonical.retryTokensEstimate - short.canonical.retryTokensEstimate);
  assert.equal(long.canonical.batchCountBasis, "duration_assumption");
  assert.equal(long.canonical.inputTokensAreHardCapped, false);
});

test("known canonical batch counts override duration assumptions, including no paid correction", () => {
  const { estimateUnifiedAnalysisBudget, estimateContentClassificationMaximumTokens } = load();
  const measured = estimateUnifiedAnalysisBudget(3600, "max", { canonicalBatchCount: 2 });
  assert.equal(measured.canonical.batchCountEstimate, 2); assert.equal(measured.canonical.batchCountBasis, "provided");
  const manual = estimateUnifiedAnalysisBudget(60, "max", { canonicalBatchCount: 0 });
  assert.equal(manual.canonical.maximumRequestCount, 0);
  assert.equal(manual.canonical.retryTokensEstimate, 0);
  assert.equal(manual.retryTextTokensEstimate, estimateContentClassificationMaximumTokens("max"));
});

test("legacy profile settings and old classification budgets never add a second long report to v11", () => {
  const altered = structuredClone(taxonomy);
  altered.budgets.max.modules = Object.fromEntries(Object.keys(altered.budgets.max.modules).map(key => [key, 999_999]));
  altered.budgets.max.input_token_limit = 999_999;
  const profile = load(altered);
  const baseline = profile.estimateAnalysisMaximumTokens(60, "max");
  profile.analysisProfileBudgets.max.outputTokens = 999_999;
  profile.analysisProfileBudgets.max.sourceTokens = 999_999;
  assert.equal(profile.estimateAnalysisMaximumTokens(60, "max"), baseline);
  assert.equal(baseline, 156_000);
  const legacy = load();
  assert.equal(legacy.analysisProfileBudgets.max.outputTokens, 12_000);
  assert.equal(legacy.estimateMediaSourceTokens(36_000, "standard"), 32_000);
  assert.ok(legacy.estimateUnifiedSourceTokens(36_000) > 32_000);
  assert.deepEqual(legacy.historicalAnalysisProfiles, ["economy", "deep"]);
  assert.equal(legacy.normalizeAnalysisProfile("max"), "max");
  assert.equal(legacy.normalizeAnalysisProfile("deep"), "standard");
});

test("unknown durations stay explicit and invalid configuration is rejected", () => {
  const { estimateUnifiedAnalysisBudget } = load();
  for (const duration of [0, -1, NaN, Infinity]) {
    const estimate = estimateUnifiedAnalysisBudget(duration, "standard");
    assert.equal(estimate.durationKnown, false);
    assert.equal(estimate.canonical.batchCountEstimate, 1);
    assert.equal(estimate.visualTokens, null);
    assert.ok(Number.isFinite(estimate.retryTextTokensEstimate));
  }
  for (const maxOutputTokens of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => estimateUnifiedAnalysisBudget(60, "max", { maxOutputTokens }), /maxOutputTokens/);
  for (const canonicalBatchCount of [-1, NaN, 1.5]) assert.throws(() => estimateUnifiedAnalysisBudget(60, "max", { canonicalBatchCount }), /canonicalBatchCount/);
});
