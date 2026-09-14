import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";
import { generationFeedback } from "../lib/ecommerce/generation-feedback.ts";
import { scriptBudget, scriptCharacterCount } from "../lib/ecommerce/generation-guide.ts";

test("course failure repair gets exact character counts, method bindings and user instructions", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (stage === "draft") {
      const missing = payload.plan.choices.filter(c => ["structure", "sop"].includes(c.kind)).map(c => c.componentId);
      for (const segment of result.segments) segment.componentIds = segment.componentIds.filter(id => !missing.includes(id));
      result.segments[0].script += "需要检查输出。".repeat(40);
      for (const application of result.applications.filter(a => missing.includes(a.sourceId))) application.draftQuote = "拼接片段……无法定位。";
    }
    return result;
  } });
  const response = await f.generate({ instructions: "只演示一次结果核验" });
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(c => c.stage), ["plan", "draft", "repair", "review"]);
  for (const call of f.calls.filter(c => c.stage !== "review")) {
    assert.equal(call.payload.instructions, "只演示一次结果核验");
    assert.equal(call.payload.generationGuide.scriptBudget.maxCharacters, 210);
  }
  const repair = f.calls.find(c => c.stage === "repair").payload;
  assert.ok(repair.generationGuide.observed.totalCharacters > 210);
  assert.ok(repair.generationGuide.observed.referenceBindings.some(b => b.reportedSegmentIds.length && !b.actualSegmentIds.length));
  assert.match(repair.errors.join("；"), /当前 \d+ 字/);
  assert.equal(repair.generationGuide.selectedMethods.length, 4);
  assert.equal(repair.generationGuide.sourceRegister.length, repair.context.sources.length);
  const pack = (await response.json()).version.pack;
  assert.ok(scriptCharacterCount(pack.segments.map(s => s.script).join("")) <= 210);
  const byKind = Object.fromEntries(repair.plan.choices.map(c => [c.kind, c.componentId]));
  for (const kind of ["structure", "sop"]) assert.ok(pack.segments.some(s => s.componentIds.includes(byKind[kind])));
});

test("unrepaired method bindings are rejected instead of silently claiming adoption", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (["draft", "repair"].includes(stage)) {
      const sop = payload.plan.choices.find(c => c.kind === "sop").componentId;
      for (const segment of result.segments) segment.componentIds = segment.componentIds.filter(id => id !== sop);
    }
    return result;
  } });
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n, 0);
});

test("character guidance uses the validator's limits and counts punctuation and Unicode", () => {
  assert.equal(scriptCharacterCount("你 好，\n😀"), 4);
  assert.equal(scriptBudget(30).maxCharacters, 210);
  assert.equal(scriptBudget(30).suggestedMaxCharacters, 150);
});

test("generation failures explain actions and hide internal IDs without disguising other errors", () => {
  const result = generationFeedback("缺少 structure 组件的实际应用；缺少 sop 组件的实际应用；来源应用与实际段落不一致：component:ec-starter-" + "a".repeat(64) + "；稿件引用片段无法定位：component:ec-starter-example；口播篇幅与目标时长明显不符：30 秒应为 30–210 字，当前 320 字");
  assert.equal(result.reasons.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /ec-starter|component:|structure|\bsop\b/);
  assert.match(result.details.join("；"), /当前 320 字/);
  assert.equal(generationFeedback("公司本月模型调用额度已用尽。"), null);
  assert.equal(generationFeedback("请选择一条已确认且未过期的主卖点。"), null);
});
