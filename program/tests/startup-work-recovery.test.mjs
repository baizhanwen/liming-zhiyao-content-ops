import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

const resource = new URL("../resources/delivery/recover-startup-work.sql", import.meta.url);
const recoverSql = () => readFileSync(existsSync(resource) ? resource : new URL("../resources/delivery/revoke-startup-sessions.sql", import.meta.url), "utf8");

async function fixture(t) {
  const f = await ecommerceGenerationFixture(t), now = "2026-10-11T00:00:00.000Z";
  const workspaceId = f.seed("script_rewrite_workspaces", { title: "Recovery synthetic", source_type: "pasted", source_label: "Synthetic", source_text: "原始文案始终保留，重启后不会用失败结果覆盖已经保存的版本。", source_hash: "synthetic", source_character_count: 30 });
  const sourceId = f.seed("script_rewrite_versions", { workspace_id: workspaceId, version: 1, variant: "source", text: "原始文案始终保留，重启后不会用失败结果覆盖已经保存的版本。" });
  const runId = f.seed("script_rewrite_runs", { workspace_id: workspaceId, variant: "light_rewrite", status: "started", source_version_id: sourceId, estimated_call_count: 2, estimated_input_tokens: 50, maximum_output_tokens: 100, prompt_version: "synthetic", validation_json: '{"checks":[{"key":"retained","passed":true}]}' });
  for (const [id, status, usage] of [["returned-call", "completed", { inputTokens: 12, outputTokens: 8, totalTokens: 20 }], ["inflight-call", "started", null]]) {
    f.seed("model_calls", { id, task_type: "script_rewrite_light_batch", provider: "fixture", model_name: "fixture", model_profile: "max", prompt_version: "synthetic", status, input_hash: "synthetic", input_json: JSON.stringify({ runId }), output_json: usage ? JSON.stringify({ usage, modelRequests: [{ usageKnown: true }] }) : null });
  }
  const memoryId = f.seed("project_memory_events", { event_type: "manual", source_type: "manual", dedupe_key: "interrupted", payload_hash: "synthetic", status: "processing", attempt_count: 1 });
  const conversationId = f.seed("project_assistant_conversations", { title: "Recovery synthetic" });
  const messageId = f.seed("project_assistant_messages", { conversation_id: conversationId, role: "assistant", status: "processing", content: "项目助理正在生成回复…" });
  const commerceRunId = f.seed("ecommerce_generation_runs", { task_id: f.task.id, idempotency_key: "interrupted", input_hash: "synthetic", base_version: 0, task_revision: 1, operation: "generate", status: "running" });
  const manifestId = f.seed("generation_source_manifests", { trace_id: "interrupted", user_id: f.identity.userId, capability: "content", source_manifest_json: "[]", status: "started", created_at: now });
  return { ...f, workspaceId, runId, memoryId, messageId, commerceRunId, manifestId };
}

test("official startup turns interrupted web work into visible failures without deleting drafts or calls", async t => {
  const f = await fixture(t), sources = f.sqlite.prepare("SELECT * FROM script_rewrite_versions").all();
  f.sqlite.exec(recoverSql());
  for (const [table, id] of [["script_rewrite_runs", f.runId], ["project_memory_events", f.memoryId], ["project_assistant_messages", f.messageId], ["ecommerce_generation_runs", f.commerceRunId], ["generation_source_manifests", f.manifestId], ["model_calls", "inflight-call"]]) {
    const row = f.sqlite.prepare(`SELECT status,error_code FROM ${table} WHERE id=?`).get(id);
    assert.equal(row.status, "failed", `${table} remains orphaned`); assert.equal(row.error_code, "WEB_PROCESS_INTERRUPTED");
  }
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM script_rewrite_versions").all(), sources);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 2);
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls WHERE id='returned-call'").get().status, "completed");
});

test("recovered rewrite totals retain acknowledged tokens and explicitly count unknown requests", async t => {
  const f = await fixture(t); f.sqlite.exec(recoverSql());
  const row = f.sqlite.prepare("SELECT * FROM script_rewrite_runs WHERE id=?").get(f.runId);
  assert.equal(row.actual_input_tokens, 12); assert.equal(row.actual_output_tokens, 8); assert.equal(row.actual_total_tokens, 20);
  const validation = JSON.parse(row.validation_json);
  assert.equal(validation.modelUsage.unknownRequestCount, 1); assert.equal(validation.checks[0].key, "retained");
});

test("startup recovery is idempotent and leaves all already-completed and prior-failed records unchanged", async t => {
  const f = await fixture(t); f.sqlite.exec(recoverSql());
  const tables = ["script_rewrite_runs", "project_memory_events", "project_assistant_messages", "ecommerce_generation_runs", "generation_source_manifests", "model_calls"];
  const rows = tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  f.sqlite.exec(recoverSql());
  assert.deepEqual(tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), rows);
});

test("interrupted memory extraction can be explicitly synced again without duplicating its source", async t => {
  const f = await fixture(t); f.sqlite.exec(recoverSql());
  const results = await f.load("lib/project-memory-event-processor.ts").syncProjectMemoryEventsWithDb(f.db, {
    organizationId: f.organizationId, projectId: f.projectId, limit: 1,
    invoke: async () => ({ content: '{"memoryOperations":[{"operation":"noop","confidence":100,"reason":"没有新的长期事实"}]}', provider: "fixture", model: "fixture", latencyMs: 1, raw: {} }),
  });
  assert.equal(results.length, 1); assert.equal(results[0].status, "completed");
  const event = f.sqlite.prepare("SELECT status,attempt_count FROM project_memory_events WHERE id=?").get(f.memoryId);
  assert.equal(event.attempt_count, 2); assert.equal(event.status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_events WHERE dedupe_key='interrupted'").get().n, 1);
});

test("assistant creates a durable pending reply and a restarted attempt cannot overwrite its failure", async t => {
  const f = await fixture(t), conversationId = f.seed("project_assistant_conversations", { title: "Pending reply" });
  let release, enter;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  const conversation = f.load("lib/project-assistant-conversation.ts");
  const attempt = conversation.runProjectAssistantConversationWithDb(f.db, {
    organizationId: f.organizationId, projectId: f.projectId, conversationId, userId: f.identity.userId,
    question: "请说明下一步如何核对工作结果", invoke: async () => { enter(); await held; return { content: '{"reply":"这是晚到的回复","recommendations":[],"citations":[]}', provider: "fixture", model: "fixture", latencyMs: 1, raw: {} }; },
  });
  await entered;
  const pending = f.sqlite.prepare("SELECT id,status FROM project_assistant_messages WHERE conversation_id=? AND role='assistant'").get(conversationId);
  assert.equal(pending.status, "processing");
  f.sqlite.exec(recoverSql()); release();
  await assert.rejects(attempt, error => error.code === "PROJECT_ASSISTANT_CHAT_INTERRUPTED");
  const messages = f.sqlite.prepare("SELECT role,status,content,error_code FROM project_assistant_messages WHERE conversation_id=?").all(conversationId);
  assert.equal(messages.length, 2); assert.equal(messages.find(row => row.role === "user").status, "completed");
  const reply = messages.find(row => row.role === "assistant");
  assert.equal(reply.status, "failed"); assert.equal(reply.error_code, "WEB_PROCESS_INTERRUPTED"); assert.ok(!reply.content.includes("这是晚到的回复"));
});

test("malformed assistant output produces a failed reply instead of an unanswered question", async t => {
  const f = await fixture(t), conversationId = f.seed("project_assistant_conversations", { title: "Invalid reply" });
  await assert.rejects(f.load("lib/project-assistant-conversation.ts").runProjectAssistantConversationWithDb(f.db, {
    organizationId: f.organizationId, projectId: f.projectId, conversationId, userId: f.identity.userId,
    question: "请说明如何核对工作结果", invoke: async () => ({ content: "{", provider: "fixture", model: "fixture", latencyMs: 1, raw: {} }),
  }));
  const rows = f.sqlite.prepare("SELECT role,status FROM project_assistant_messages WHERE conversation_id=?").all(conversationId);
  assert.equal(rows.length, 2); assert.equal(rows.find(row => row.role === "assistant").status, "failed");
});

test("a provider receipt ended by restart is terminal and content generation cannot repair or save it", async t => {
  let f;
  f = await contentGenerationFixture(t, [], (_input, _count, base) => { f.sqlite.exec(recoverSql()); return base; });
  const before = f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version;
  const response = await f.complete(); assert.equal(response.status, 502);
  const data = await response.json(); assert.equal(data.error.code, "MODEL_REQUEST_INTERRUPTED");
  assert.equal(f.calls.length, 1); assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, before);
  const receipt = f.sqlite.prepare("SELECT status,error_code FROM model_calls").get();
  assert.equal(receipt.status, "failed"); assert.equal(receipt.error_code, "WEB_PROCESS_INTERRUPTED");
});
