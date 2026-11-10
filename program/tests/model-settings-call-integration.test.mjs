import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

const saved = role => ({ provider: "fixture", baseUrl: "https://models.example.invalid/v1", model: `${role}-saved`, apiKey: `synthetic-${role}-key` });

async function fixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", MODEL_SETTINGS_ENCRYPTION_KEY: "ab".repeat(32),
    CONTENT_MODEL_PROVIDER: "environment", CONTENT_MODEL_BASE_URL: "https://environment.example.invalid/v1", CONTENT_MODEL_NAME: "environment-model", CONTENT_MODEL_API_KEY: "synthetic-environment-key" } });
  const installation = await f.initialize(); f.identity.userId = installation.userId;
  const now = new Date().toISOString(), projectId = "configured-project";
  f.sqlite.prepare("INSERT INTO projects (id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(projectId, installation.organizationId, "Synthetic project", "Synthetic client", installation.userId, installation.userId, now, now);
  const models = f.load("lib/model-settings.ts");
  await models.saveModelSettings(installation.organizationId, installation.userId, { contentGeneration: saved("content"), projectAssistant: saved("assistant") }, 0);
  return { ...f, ...installation, projectId };
}

test("recorded content uses its authorized organization's saved model and retains request accounting", async t => {
  const f = await fixture(t), requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  });
  const ledger = [], id = crypto.randomUUID();
  const response = await f.load("lib/recorded-content-model.ts").invokeRecordedContentRequest({ organizationId: "foreign-input-must-not-win", system: "synthetic", user: "synthetic", profile: "max" }, {
    id, rootCallId: id, organizationId: f.organizationId, projectId: f.projectId, userId: f.userId, topicId: null, promptTemplateId: null,
    taskType: "synthetic.check", promptVersion: "synthetic", provider: "fixture", model: "content-saved", step: "synthetic", inputHash: "synthetic", inputJson: "{}", monthlyLimit: 100, ledger,
  });
  assert.equal(response.model, "content-saved");
  assert.equal(requests[0].url, "https://models.example.invalid/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer synthetic-content-key");
  assert.equal(requests[0].body.model, "content-saved");
  assert.equal(ledger[0].totalTokens, 5);
  assert.doesNotMatch(JSON.stringify(f.sqlite.prepare("SELECT input_json,output_json FROM model_calls").all()), /synthetic-content-key/);
});

test("recorded assistant uses its saved independent role and preserves the paid request ledger", async t => {
  const f = await fixture(t), requests = [];
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit: 100 }) });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push({ body: JSON.parse(init.body), authorization: init.headers.authorization });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  });
  const invoke = f.load("lib/recorded-project-assistant-model.ts").createRecordedProjectAssistantInvoker({ organizationId: f.organizationId, projectId: f.projectId, userId: f.userId, taskType: "project_assistant.probe", promptVersion: "synthetic" });
  await invoke({ organizationId: "foreign-input-must-not-win", system: "synthetic", user: "synthetic" });
  assert.equal(requests[0].body.model, "assistant-saved");
  assert.equal(requests[0].authorization, "Bearer synthetic-assistant-key");
  const row = f.sqlite.prepare("SELECT model_name,status,output_json FROM model_calls").get();
  assert.equal(row.model_name, "assistant-saved"); assert.equal(row.status, "completed");
  assert.equal(JSON.parse(row.output_json).modelRequests[0].totalTokens, 5);
});

test("ecommerce reads its organization configuration for preflight and all recorded stages", async t => {
  const f = await ecommerceGenerationFixture(t), adapter = f.load("lib/model-adapter.ts"), configurations = [];
  f.mockModule("cloudflare:workers", { env: { MODEL_SETTINGS_ENCRYPTION_KEY: "ab".repeat(32) } });
  await f.load("lib/model-settings.ts").saveModelSettings(f.organizationId, f.identity.userId, { contentGeneration: saved("commerce") }, 0);
  f.mock("lib/model-adapter.ts", { ...adapter,
    readContentModelConfig(profile, runtime) {
      assert.equal(runtime.CONTENT_MODEL_NAME, "commerce-saved");
      assert.equal(runtime.CONTENT_MODEL_API_KEY, "synthetic-commerce-key");
      return { profile, provider: runtime.CONTENT_MODEL_PROVIDER, model: runtime.CONTENT_MODEL_NAME, baseUrl: runtime.CONTENT_MODEL_BASE_URL, apiKey: runtime.CONTENT_MODEL_API_KEY };
    },
    invokeContentModel(input, options) {
      assert.equal(input.organizationId, f.organizationId);
      assert.equal(options.config.model, "commerce-saved");
      configurations.push(options.config.model);
      return adapter.invokeContentModel(input);
    },
  });
  const response = await f.generate(); assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(configurations, ["commerce-saved", "commerce-saved", "commerce-saved"]);
  assert.ok(f.sqlite.prepare("SELECT model_name FROM model_calls").all().every(row => row.model_name === "commerce-saved"));
});
