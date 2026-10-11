import assert from "node:assert/strict";
import test from "node:test";
import { fixture as benchmarkFixture } from "./helpers/single-benchmark-fixture.mjs";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

test("benchmark structure, draft and review each count as one provider request", async t => {
  const f = await benchmarkFixture(t);
  assert.equal((await f.complete()).status, 200);
  assert.equal(f.calls.length, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 3);
  const root = f.sqlite.prepare("SELECT * FROM model_calls WHERE task_type='content_draft'").get();
  assert.equal(root.status, "completed");
  const requests = JSON.parse(root.output_json).modelRequests;
  assert.deepEqual(requests.map(r => r.step), ["benchmark_structure", "generation", "benchmark_review"]);
  assert.ok(requests.every(r => r.usageKnown === false && r.totalTokens === null));
  assert.equal(f.sqlite.prepare("SELECT model_call_id FROM content_versions WHERE content_item_id=? AND version=2").get(f.contentId).model_call_id, root.id);
});

test("a rejected draft and its revision consume separate requests", async t => {
  const f = await benchmarkFixture(t, { shortFirst: true });
  assert.equal((await f.complete()).status, 200);
  assert.equal(f.calls.length, 4);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 4);
});

test("failed provider requests and their retry remain counted with unknown usage", async t => {
  let RequestError;
  const f = await contentGenerationFixture(t, [], () => { throw new RequestError("synthetic transport timeout", "MODEL_TIMEOUT"); });
  RequestError = f.load("lib/model-adapter.ts").ModelRequestError;
  const response = await f.complete();
  assert.equal(response.status, 502);
  assert.equal(f.calls.length, 2);
  const rows = f.sqlite.prepare("SELECT * FROM model_calls").all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === "failed"));
  const root = rows.find(row => row.task_type === "content_draft");
  const requests = JSON.parse(root.output_json).modelRequests;
  assert.equal(requests.length, 2);
  assert.ok(requests.every(row => row.status === "failed" && row.usageKnown === false && row.totalTokens === null));
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
});

test("a workflow stops before exceeding its remaining monthly request budget", async t => {
  const f = await benchmarkFixture(t, { quotaLimit: 1 });
  const response = await f.complete();
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "MODEL_QUOTA_EXCEEDED");
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls").get().status, "failed");
});

test("three concurrent reservations for one remaining request send only one provider call", async t => {
  let providerCalls = 0;
  const modelAdapter = {
    ModelConfigurationError: class extends Error {}, ModelRequestError: class extends Error { constructor(message, code) { super(message); this.code = code; } },
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async () => {
      providerCalls += 1;
      return { content: "synthetic response", latencyMs: 1, raw: { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } } };
    },
  };
  const f = await contentGenerationFixture(t, [], undefined, { modelAdapter });
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  const promptTemplateId = f.seed("prompt_templates", { task_type: "content_draft", version: "accounting-fixture", name: "Synthetic", system_prompt: "Synthetic", output_schema_json: "{}" });
  const invoke = f.load("lib/recorded-content-model.ts").invokeRecordedContentRequest;
  const ledger = [];
  const input = { system: "synthetic", user: "synthetic", profile: "max" };
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => {
    const id = crypto.randomUUID();
    return invoke(input, { id, rootCallId: id, organizationId, projectId: "project", topicId: f.topicId, promptTemplateId, promptVersion: "fixture", provider: "fixture", model: "fixture", userId: f.identity.userId, step: "generation", inputHash: "synthetic", inputJson: "{}", monthlyLimit: 1, ledger });
  }));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 1);
  assert.equal(ledger[0].totalTokens, 20);
  assert.equal(ledger[0].usageKnown, true);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason.code === "MODEL_QUOTA_EXCEEDED"));
});
