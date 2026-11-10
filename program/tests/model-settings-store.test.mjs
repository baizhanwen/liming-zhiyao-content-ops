import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  const runtime = { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", MODEL_SETTINGS_ENCRYPTION_KEY: "ab".repeat(32),
    ANALYZER_LLM_PROVIDER: "fixture", ANALYZER_LLM_BASE_URL: "https://models.example.invalid/v1", ANALYZER_LLM_MODEL: "default-model", ANALYZER_LLM_API_KEY: "synthetic-environment-key" };
  f.mockModule("cloudflare:workers", { env: runtime });
  const installation = await f.initialize();
  f.identity.userId = installation.userId;
  return { f, installation, runtime, models: f.load("lib/model-settings.ts") };
}

test("saved secrets are encrypted, scoped to the organization, and absent from public settings and audit", async t => {
  const { f, installation: i, models } = await fixture(t);
  const patch = { provider: "fixture", baseUrl: "https://models.example.invalid/v1", model: "organization-model", apiKey: "synthetic-private-organization-key" };
  const result = await models.saveModelSettings(i.organizationId, i.userId, { analysisText: patch }, 0);
  assert.equal(result.roles.analysisText.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-organization-key/);
  const row = f.sqlite.prepare("SELECT settings_json FROM organization_model_settings").get();
  assert.doesNotMatch(row.settings_json, /synthetic-private-organization-key/);
  assert.match(row.settings_json, /v1\./);
  const effective = await models.readEffectiveModelRuntime(i.organizationId);
  assert.equal(effective.ANALYZER_LLM_API_KEY, patch.apiKey);
  const other = await models.readEffectiveModelRuntime(crypto.randomUUID());
  assert.equal(other.ANALYZER_LLM_API_KEY, "synthetic-environment-key");
  assert.doesNotMatch(JSON.stringify(f.sqlite.prepare("SELECT metadata_json FROM audit_logs").all()), /synthetic-private-organization-key/);
});

test("blank secrets preserve the saved value, changed endpoints require a new secret, and explicit clear stays cleared", async t => {
  const { installation: i, models } = await fixture(t);
  const patch = { provider: "fixture", baseUrl: "https://models.example.invalid/v1", model: "organization-model" };
  await models.saveModelSettings(i.organizationId, i.userId, { contentGeneration: patch }, 0);
  await models.saveModelSettings(i.organizationId, i.userId, { contentGeneration: { ...patch, model: "new-model" } }, 1);
  assert.equal((await models.readEffectiveModelRuntime(i.organizationId)).CONTENT_MODEL_API_KEY, "synthetic-environment-key");
  await assert.rejects(models.saveModelSettings(i.organizationId, i.userId, { contentGeneration: { ...patch, baseUrl: "https://another.example.invalid/v1" } }, 2), error => error.code === "NEW_MODEL_KEY_REQUIRED");
  await models.saveModelSettings(i.organizationId, i.userId, { contentGeneration: { ...patch, clearApiKey: true } }, 2);
  const cleared = await models.readEffectiveModelRuntime(i.organizationId);
  assert.equal(cleared.CONTENT_MODEL_API_KEY, "");
  assert.equal(cleared.CONTENT_MODEL_CONFIGURED_IN_UI, "1");
  assert.equal((await models.readModelSettings(i.organizationId)).roles.contentGeneration.apiKeyConfigured, false);
  await assert.rejects(models.saveModelSettings(i.organizationId, i.userId, { contentGeneration: patch }, 1), error => error.code === "MODEL_SETTINGS_CONFLICT");
});

test("encrypted credentials cannot be replayed under a different role or endpoint", async t => {
  const { f, installation: i, models } = await fixture(t);
  await models.saveModelSettings(i.organizationId, i.userId, { analysisText: { provider: "fixture", baseUrl: "https://models.example.invalid/v1", model: "model", apiKey: "synthetic-role-bound-key" } }, 0);
  const data = JSON.parse(f.sqlite.prepare("SELECT settings_json FROM organization_model_settings").get().settings_json);
  data.analysisText.baseUrl = "https://changed.example.invalid/v1";
  f.sqlite.prepare("UPDATE organization_model_settings SET settings_json = ?").run(JSON.stringify(data));
  await assert.rejects(models.readEffectiveModelRuntime(i.organizationId), error => error.code === "MODEL_SETTINGS_DECRYPT_FAILED");
});

test("model settings reject private endpoints and deny non-admin reads and writes", async t => {
  const { f, installation: i, models } = await fixture(t);
  for (const url of ["http://localhost:3000/v1", "https://127.0.0.1/v1", "https://secret@api.example.invalid/v1", "https://models.local/v1"]) {
    assert.throws(() => models.validateModelEndpoint(url));
  }
  f.identity.role = "member";
  const route = f.load("app/api/model-settings/route.ts");
  const get = await route.GET(new Request("https://app.example.invalid/api/model-settings?organizationId=" + i.organizationId));
  assert.equal(get.status, 403);
  const put = await route.PUT(new Request("https://app.example.invalid/api/model-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: i.organizationId, roles: {} }) }));
  assert.equal(put.status, 403);
});

test("a freshly queued leased job can read its model snapshot while other workers and stale versions cannot", async t => {
  const { f, installation: i } = await fixture(t);
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID(), videoId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: i.organizationId, project_id: projectId, created_by: i.userId, updated_by: i.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  };
  seed("projects", { id: projectId, name: "Fixture", client_name: "Fixture" });
  seed("videos", { id: videoId, platform: "douyin", source_type: "url" });
  seed("analysis_jobs", { id: jobId, video_id: videoId, source_type: "url", source_ref: "fixture", idempotency_key: jobId, status: "queued", version: 3, lease_owner: "fixture-worker", lease_expires_at: new Date(Date.now() + 60_000).toISOString() });
  f.mock("lib/service-auth.ts", { requireAnalyzerService: async () => ({ authenticated: true }), normalizeWorkerId: value => value });
  const route = f.load("app/api/internal/analysis-jobs/[jobId]/model-settings/route.ts");
  const request = (workerId, version) => new Request("https://app.example.invalid/api/internal/analysis-jobs/fixture/model-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId, version }) });
  const context = { params: Promise.resolve({ jobId }) };
  const valid = await route.POST(request("fixture-worker", 3), context);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).configuration.llm_model, "default-model");
  assert.equal((await route.POST(request("another-worker", 3), context)).status, 409);
  assert.equal((await route.POST(request("fixture-worker", 2), context)).status, 409);
});
