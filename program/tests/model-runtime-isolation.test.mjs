import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

function syntheticRuntime(label) {
  return {
    ANALYZER_SERVICE_TOKEN: "synthetic-service-token",
    ANALYZER_LLM_PROVIDER: "synthetic-analysis",
    ANALYZER_LLM_BASE_URL: "https://analysis.example.invalid/v1",
    ANALYZER_LLM_MODEL: "synthetic-analysis-model-" + label,
    ANALYZER_LLM_API_KEY: "synthetic-analysis-key-" + label,
    CONTENT_MODEL_PROVIDER: "synthetic-content",
    CONTENT_MODEL_BASE_URL: "https://content.example.invalid/v1",
    CONTENT_MODEL_NAME: "synthetic-content-model-" + label,
    CONTENT_MODEL_API_KEY: "synthetic-content-key-" + label,
    PROJECT_ASSISTANT_MODEL_PROVIDER: "synthetic-assistant",
    PROJECT_ASSISTANT_MODEL_BASE_URL: "https://assistant.example.invalid/v1",
    PROJECT_ASSISTANT_MODEL_NAME: "synthetic-assistant-model-" + label,
    PROJECT_ASSISTANT_MODEL_API_KEY: "synthetic-assistant-key-" + label,
  };
}

function scopedFixture(t) {
  const f = runtimeFixture(t);
  const records = new Map([["organization-a", syntheticRuntime("a")], ["organization-b", syntheticRuntime("b")]]);
  const scopes = [];
  f.mock("lib/model-settings.ts", {
    readEffectiveModelRuntime: async organizationId => {
      scopes.push(organizationId);
      const config = records.get(organizationId);
      if (!config) throw new Error("Unknown synthetic organization");
      return { ...config };
    },
  });
  return { f, records, scopes };
}

test("concurrent content invocations use each organization's saved model and credential", async t => {
  const { f, scopes } = scopedFixture(t);
  const requests = [];
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ model: payload.model, authorization: options.headers.authorization });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });
  };
  const { invokeContentModel } = f.load("lib/model-adapter.ts");
  const results = await Promise.all(["organization-a", "organization-b"].map(organizationId => invokeContentModel({ organizationId, system: "synthetic", user: "synthetic", profile: "max" })));
  assert.deepEqual(scopes.sort(), ["organization-a", "organization-b"]);
  assert.deepEqual(results.map(result => result.model), ["synthetic-content-model-a", "synthetic-content-model-b"]);
  for (const suffix of ["a", "b"]) {
    assert.ok(requests.some(request => request.model === "synthetic-content-model-" + suffix && request.authorization === "Bearer synthetic-content-key-" + suffix));
  }
});

test("a request config snapshot remains consistent after settings change; later requests use the update", async t => {
  const { f, records } = scopedFixture(t);
  const { invokeContentModel, readContentModelConfig } = f.load("lib/model-adapter.ts");
  const config = readContentModelConfig("max", records.get("organization-a"));
  records.set("organization-a", syntheticRuntime("changed"));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (_url, options) => Response.json({ choices: [{ message: { content: JSON.parse(options.body).model }, finish_reason: "stop" }] });
  const oldRequest = await invokeContentModel({ organizationId: "organization-a", system: "synthetic", user: "synthetic", profile: "max" }, { config });
  const newRequest = await invokeContentModel({ organizationId: "organization-a", system: "synthetic", user: "synthetic", profile: "max" });
  assert.equal(oldRequest.model, "synthetic-content-model-a");
  assert.equal(newRequest.model, "synthetic-content-model-changed");
});

test("project assistant resolves its own organization role without falling back to content credentials", async t => {
  const { f, scopes } = scopedFixture(t);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ model: payload.model, authorization: options.headers.authorization });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  const { invokeProjectAssistantModel } = f.load("lib/project-assistant-model.ts");
  const results = await Promise.all(["organization-a", "organization-b"].map(organizationId => invokeProjectAssistantModel({ organizationId, system: "synthetic", user: "synthetic" }, { fetchImpl })));
  assert.deepEqual(scopes.sort(), ["organization-a", "organization-b"]);
  assert.deepEqual(results.map(result => result.model), ["synthetic-assistant-model-a", "synthetic-assistant-model-b"]);
  assert.ok(requests.every(request => request.authorization.startsWith("Bearer synthetic-assistant-key-")));
});

test("clearing a saved content credential never falls back to the analysis credential", async t => {
  const { f } = scopedFixture(t);
  const { readContentModelConfig, ModelConfigurationError } = f.load("lib/model-adapter.ts");
  const runtime = { ...syntheticRuntime("cleared"), CONTENT_MODEL_CONFIGURED_IN_UI: "1", CONTENT_MODEL_API_KEY: "" };
  assert.throws(() => readContentModelConfig("max", runtime), ModelConfigurationError);
  const { readModelServiceStatuses } = f.load("lib/model-service-status.ts");
  const status = readModelServiceStatuses(runtime);
  assert.equal(status.contentGeneration.configured, false);
  assert.equal(status.contentGeneration.isolation, "independent");
  assert.equal(status.analysisText.configured, true);
});

test("MiniMax-M3.1-Flash ordinary API image configuration is distinct from legacy MiniMax-M3", t => {
  const { f } = scopedFixture(t);
  const { readModelServiceStatuses } = f.load("lib/model-service-status.ts");
  const runtime = {
    ANALYZER_VISION_PROVIDER: "minimax", ANALYZER_VISION_MODEL: "MiniMax-M3.1-Flash",
    ANALYZER_VISION_BASE_URL: "https://api.minimax.cn/v1", ANALYZER_VISION_API_KEY: "sk-cp-synthetic-explicit-flash-key",
  };
  const { isMiniMaxOpenAiVisionRuntime, visionConfigurationFingerprint } = f.load("lib/minimax-vision.ts");
  assert.equal(isMiniMaxOpenAiVisionRuntime(runtime), true);
  assert.notEqual(visionConfigurationFingerprint(runtime), visionConfigurationFingerprint({ ...runtime, ANALYZER_VISION_BASE_URL: "https://api.minimax.io/v1" }));
  const current = readModelServiceStatuses(runtime).visualUnderstanding;
  assert.equal(current.configured, true);
  assert.equal(current.model, "MiniMax-M3.1-Flash");
  assert.equal(current.readiness, "pending_probe");
  const legacy = readModelServiceStatuses({ ...runtime, ANALYZER_VISION_MODEL: "MiniMax-M3", ANALYZER_VISION_API_KEY: "synthetic-normal-api-key" }).visualUnderstanding;
  assert.equal(legacy.configured, false);
});

test("MiniMax Flash uses the source lmzy reasoning budget and keeps reasoning separate from response text", async t => {
  const { f } = scopedFixture(t);
  const runtime = {
    CONTENT_MODEL_PROVIDER: "minimax", CONTENT_MODEL_BASE_URL: "https://model.example.invalid/v1",
    CONTENT_MODEL_NAME: "MiniMax-M3.1-Flash", CONTENT_MODEL_API_KEY: "synthetic-minimax-key",
  };
  const { invokeContentModel, readContentModelConfig } = f.load("lib/model-adapter.ts");
  const { invokeProjectAssistantModel } = f.load("lib/project-assistant-model.ts");
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: '{"ok":true}', reasoning_content: "synthetic private reasoning" }, finish_reason: "stop" }] });
  };
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = fetchImpl;
  const content = await invokeContentModel({ system: "synthetic", user: "synthetic", profile: "max", maxTokens: 100 }, { config: readContentModelConfig("max", runtime) });
  const assistant = await invokeProjectAssistantModel({ system: "synthetic", user: "synthetic", maxTokens: 80 }, { config: { provider: "minimax", model: "MiniMax-M3.1-Flash", baseUrl: runtime.CONTENT_MODEL_BASE_URL, apiKey: runtime.CONTENT_MODEL_API_KEY }, fetchImpl });
  assert.equal(content.content, '{"ok":true}');
  assert.equal(assistant.content, '{"ok":true}');
  for (const request of requests) {
    assert.equal(request.reasoning_effort, "low");
    assert.equal(request.max_completion_tokens, 16384);
    assert.equal("max_tokens" in request, false);
    assert.equal("response_format" in request, false);
    assert.equal("thinking" in request, false);
  }
});
