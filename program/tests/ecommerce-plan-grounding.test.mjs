import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

// The model selects immutable keys. These integration tests check that the
// persisted plan and drafting request receive server-owned source text/beats.
function setMethodKeys(result, payload) {
  const method = payload.generationGuide.copyMethodology.methodCandidates.frameworks.find(item => item.id === result.methodSelection.frameworkId);
  for (const segment of result.outline) segment.methodBeats = segment.methodBeats.map(beat => `main-${method.beats.indexOf(beat) + 1}`);
  for (const fact of result.factPlan) delete fact.sourceQuote;
  return method;
}

test("model beat IDs and fact keys become exact source text before drafting and persistence", async t => {
  let expected;
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (stage === "plan") {
      const method = setMethodKeys(result, payload);
      expected = { beats: method.beats, facts: payload.generationGuide.factRegister };
    }
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review"]);
  const row = f.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions WHERE task_id=?").get(f.task.id);
  const snapshot = JSON.parse(row.input_snapshot_json), draftPlan = f.calls.find(call => call.stage === "draft").payload.plan;
  assert.deepEqual(snapshot.plan, draftPlan);
  for (const fact of snapshot.plan.factPlan) {
    const source = expected.facts.find(item => item.sourceKey === fact.sourceKey);
    assert.ok(source);
    assert.equal(fact.sourceQuote, source.text);
    assert.ok(source.text.length);
  }
  const actual = snapshot.plan.outline.flatMap(segment => segment.methodBeats);
  assert.ok(expected.beats.every(beat => actual.includes(beat)));
  assert.ok(actual.every(beat => expected.beats.includes(beat) || beat === "action"));
  assert.ok(!actual.some(beat => /^(?:main|supplement)-\d$/u.test(beat)));
});

test("a model-supplied quote cannot replace source text for a valid fact key", async t => {
  const invented = "伪造体验：本商品让效率提升999倍，已获虚构认证";
  let actualSource;
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (stage === "plan") {
      setMethodKeys(result, payload);
      actualSource = payload.generationGuide.factRegister.find(item => item.sourceKey === result.factPlan[0].sourceKey).text;
      result.factPlan[0].sourceQuote = invented;
    }
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const snapshot = JSON.parse(f.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions WHERE task_id=?").get(f.task.id).input_snapshot_json);
  assert.equal(snapshot.plan.factPlan[0].sourceQuote, actualSource);
  assert.ok(!JSON.stringify(snapshot).includes(invented));
  assert.ok(!JSON.stringify(f.calls.find(call => call.stage === "draft").payload).includes(invented));
});

test("an unknown fact key is rejected before drafting even if its invented quote looks plausible", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (stage === "plan") {
      setMethodKeys(result, payload);
      result.factPlan[0].sourceKey = "fact-not-provided";
      result.factPlan[0].sourceQuote = "合成杯具有未提供的实验认证";
    }
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "PLAN_REJECTED");
  assert.match(body.error.message, /事实无法在来源中定位/);
  assert.deepEqual(f.calls.map(call => call.stage), ["plan"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
});

for (const invalidBeat of ["main-9", "supplement-1", "伪造：行业销量第一"]) test(`unprovided method step is rejected instead of materialized: ${invalidBeat}`, async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result, payload }) => {
    if (stage === "plan") {
      setMethodKeys(result, payload);
      result.outline[1].methodBeats.push(invalidBeat);
    }
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.error.code, "PLAN_REJECTED");
  assert.match(body.error.message, /不属于所选方法的推进步骤/);
  assert.deepEqual(f.calls.map(call => call.stage), ["plan"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
});
