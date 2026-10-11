import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

class AssistantError extends Error { constructor(message, code = "PROJECT_ASSISTANT_REQUEST_FAILED") { super(message); this.code = code; } }
async function fixture(t, limit = 1000) {
  const f = await contentGenerationFixture(t); const calls = [];
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit }) });
  f.mock("lib/project-assistant-model.ts", {
    ProjectAssistantConfigurationError: class extends Error {}, ProjectAssistantRequestError: AssistantError,
    readProjectAssistantModelConfig: () => ({ provider: "independent", model: "assistant-fixture", apiKey: "synthetic", baseUrl: "https://example.invalid" }),
    projectAssistantConfigurationStatus: () => ({ configured: true }),
    invokeProjectAssistantModel: async input => {
      calls.push(input); return { provider: "independent", model: "assistant-fixture", latencyMs: 1, raw: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        content: JSON.stringify({ reply: "当前暂无对标资料，可以先用一个具体问题验证方向。", recommendations: [], citations: [], memoryOperations: [{ operation: "noop", confidence: 100, reason: "没有新证据" }] }) };
    },
    probeProjectAssistantModel: async invoke => { const result = await (invoke ?? (() => { calls.push("legacy probe"); return { provider: "independent", model: "assistant-fixture", latencyMs: 1 }; }))({ system: "probe", user: "probe", maxTokens: 80 }); return { ok: true, provider: result.provider, model: result.model, latencyMs: result.latencyMs }; },
  });
  const scope = { organizationId, projectId: "project", userId: f.identity.userId };
  const conversation = await f.load("lib/project-assistant-conversation.ts").createProjectAssistantConversationWithDb(f.db, scope);
  const request = body => new Request("http://localhost/api/project-assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...scope, ...body }) });
  const chat = () => f.load("app/api/project-assistant/conversations/[conversationId]/messages/route.ts").POST(request({ question: "请推荐三个系列选题" }), { params: Promise.resolve({ conversationId: conversation.id }) });
  const extract = async () => {
    const eventId = f.seed("project_memory_events", { event_type: "manual", source_type: "manual", source_id: "synthetic", dedupe_key: "synthetic", payload_hash: "synthetic", payload_json: "{}" });
    return f.load("lib/project-memory-event-processor.ts").processProjectMemoryEventWithDb(f.db, { ...scope, eventId });
  };
  const probe = () => f.load("app/api/project-assistant/status/route.ts").POST(request({}));
  return { ...f, calls, chat, extract, probe };
}

test("assistant chat repair, memory extraction and explicit probe record independent requests", async t => {
  const f = await fixture(t); const response = await f.chat(); assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await f.extract()).status, "completed"); assert.equal((await f.probe()).status, 200);
  const rows = f.sqlite.prepare("SELECT * FROM model_calls").all();
  assert.equal(f.calls.length, 4); assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.provider === "independent" && row.status === "completed"));
  assert.ok(rows.every(row => JSON.parse(row.output_json).modelRequests[0].totalTokens === 5));
});

test("assistant quota blocks new chat, memory and probe requests before spending", async t => {
  const f = await fixture(t, 0);
  const response = await f.chat(); assert.equal(response.status, 429, await response.clone().text());
  const memory = await f.extract(); assert.equal(memory.status, "failed");
  assert.equal(f.sqlite.prepare("SELECT error_code FROM project_memory_events").get().error_code, "MODEL_QUOTA_EXCEEDED");
  assert.equal((await f.probe()).status, 429);
  assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
});

test("assistant callers with stale snapshots compete for one remaining slot", async t => {
  const f = await fixture(t, 1); const responses = await Promise.all([f.chat(), f.chat(), f.chat()]);
  assert.equal(f.calls.length, 1); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 1);
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 429).length, 2);
});

test("viewing assistant status is free and read-only access cannot trigger a paid probe", async t => {
  const f = await fixture(t);
  const scope = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId);
  const route = f.load("app/api/project-assistant/status/route.ts");
  assert.equal((await route.GET(new Request(`http://localhost/api/project-assistant/status?organizationId=${scope.organization_id}&projectId=project`))).status, 200);
  f.runtime.canWriteProjectAccess = () => false;
  assert.equal((await f.probe()).status, 403); assert.equal(f.calls.length, 0);
});
