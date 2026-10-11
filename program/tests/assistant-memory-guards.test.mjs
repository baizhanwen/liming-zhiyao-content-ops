import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

class AssistantError extends Error { constructor(message, code) { super(message); this.code = code; } }
const operation = (key, content) => ({ operation: "add", canonicalKey: key, title: key, content, confidence: 90, evidence: [{ sourceType: "manual", sourceId: key, quote: content }], mergeFromKeys: [], reason: "合成验收资料" });
const operations = [operation("task-input", "交代任务前明确输入资料和负责提供资料的人员。"), operation("review-date", "审核前约定复查时间，按截止日期安排人员。")];
async function fixture(t, hook = () => {}, responseOperations = operations, question = "请说明如何核对任务资料") {
  const f = await contentGenerationFixture(t), calls = [], organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  const scope = { organizationId, projectId: "project", userId: f.identity.userId };
  f.mock("lib/video-knowledge-atoms.ts", { backfillProjectBenchmarkKnowledgeAtoms: async () => ({ created: 0 }) });
  f.mock("lib/project-assistant-model.ts", {
    ProjectAssistantConfigurationError: class extends Error {}, ProjectAssistantRequestError: AssistantError,
    readProjectAssistantModelConfig: () => ({ provider: "independent", model: "synthetic" }),
    projectAssistantConfigurationStatus: () => ({ configured: true }),
    invokeProjectAssistantModel: async input => {
      calls.push(input); await hook(f, calls.length);
      return { provider: "independent", model: "synthetic", latencyMs: 1, raw: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, content: JSON.stringify({ reply: "请先明确输入资料，再按复查时间核对结果。", recommendations: [], citations: [], memoryOperations: responseOperations }) };
    },
    probeProjectAssistantModel: async invoke => ({ ok: true, ...await invoke({ system: "probe", user: "probe" }) }),
  });
  const conversation = await f.load("lib/project-assistant-conversation.ts").createProjectAssistantConversationWithDb(f.db, scope);
  const eventId = f.seed("project_memory_events", { event_type: "manual", source_type: "manual", source_id: "synthetic", dedupe_key: "synthetic", payload_hash: "synthetic", payload_json: "{}" });
  Object.assign(f, { scope, eventId });
  const invoke = kind => kind === "chat" ? f.load("app/api/project-assistant/conversations/[conversationId]/messages/route.ts").POST(f.request({ question }), { params: Promise.resolve({ conversationId: conversation.id }) }) : f.load(kind === "memory" ? "app/api/project-memory/sync/route.ts" : "app/api/project-assistant/status/route.ts").POST(f.request({ limit: 3 }));
  return { ...f, scope, calls, eventId, conversation, invoke };
}
const changes = [
  ["company membership removed", f => f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.scope.userId)],
  ["user disabled", f => f.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.scope.userId)],
  ["project archived", f => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='project'").run()],
  ["login expired", f => { f.identity.userId = "expired-session"; }],
];
for (const kind of ["chat", "memory", "probe"]) {
  test(`${kind}: normal independent model work still succeeds`, async t => {
    const f = await fixture(t), response = await f.invoke(kind); assert.equal(response.status, kind === "chat" ? 201 : 200, await response.clone().text()); assert.equal(f.calls.length, 1);
  });
  for (const [name, change] of changes) test(`${kind}: ${name} while waiting refuses output and preserves actual usage`, async t => {
    const f = await fixture(t, change), response = await f.invoke(kind); assert.equal(response.status, 403, await response.clone().text());
    assert.equal((await response.json()).error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(f.calls.length, 1);
    const receipt = f.sqlite.prepare("SELECT status,error_code,output_json FROM model_calls").get(); assert.equal(receipt.status, "failed"); assert.equal(receipt.error_code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(JSON.parse(receipt.output_json).modelRequests[0].totalTokens, 5);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE role='assistant' AND status='completed'").get().n, 0);
  });
  test(`${kind}: reservation checks current permission and sends no paid request`, async t => {
    const f = await fixture(t), prepare = f.db.prepare;
    f.db.prepare = sql => { const statement = prepare(sql), run = statement.run; statement.run = async () => { if (sql.startsWith("INSERT INTO model_calls")) changes[0][1](f); return run(); }; return statement; };
    const response = await f.invoke(kind); assert.equal(response.status, 403, await response.clone().text()); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
  });
  test(`${kind}: revoking an employee project assignment denies the late result`, async t => {
    const f = await fixture(t, row => row.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(row.scope.userId));
    f.sqlite.prepare("UPDATE organization_members SET role='employee' WHERE user_id=?").run(f.scope.userId);
    f.seed("project_members", { user_id: f.scope.userId, role: "editor", status: "active" });
    const response = await f.invoke(kind); assert.equal(response.status, 403, await response.clone().text()); assert.equal(f.calls.length, 1);
  });
}
for (const kind of ["chat", "memory"]) test(`${kind}: permission changes at final transaction leave no completed reply or candidates`, async t => {
  const f = await fixture(t), prepare = f.db.prepare, batch = f.db.batch;
  f.db.prepare = sql => { const s = prepare(sql); s.auditSql = sql; return s; };
  f.db.batch = async statements => { if (statements.some(s => /UPDATE project_assistant_messages SET status='completed'|INSERT INTO project_memory_items/.test(s.auditSql))) changes[0][1](f); return batch(statements); };
  const response = await f.invoke(kind); assert.equal(response.status, 403, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_evidence").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE role='assistant' AND status='completed'").get().n, 0);
});
test("memory is processed by the current admin even when its historical author is disabled", async t => {
  const f = await fixture(t), author = f.seed("users", { auth_subject: "historical-author", email: "old@example.invalid", display_name: "Historical", status: "disabled" });
  f.sqlite.prepare("UPDATE project_memory_events SET created_by=? WHERE id=?").run(author, f.eventId);
  const response = await f.invoke("memory"); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT created_by FROM model_calls").get().created_by, f.scope.userId);
  assert.equal(f.sqlite.prepare("SELECT created_by FROM project_memory_events WHERE id=?").get(f.eventId).created_by, author);
});
test("memory evidence failure in the second operation rolls back the entire extraction and retries cleanly", async t => {
  const f = await fixture(t);
  f.sqlite.exec("CREATE TRIGGER injected_memory_failure BEFORE INSERT ON project_memory_evidence WHEN NEW.source_id='review-date' BEGIN SELECT RAISE(ABORT,'injected evidence failure'); END;");
  await f.invoke("memory"); assert.equal(f.sqlite.prepare("SELECT status FROM project_memory_events WHERE id=?").get(f.eventId).status, "failed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_evidence").get().n, 0);
  f.sqlite.exec("DROP TRIGGER injected_memory_failure"); const response = await f.invoke("memory"); assert.equal(response.status, 200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 2); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_evidence").get().n, 2);
  assert.equal(f.sqlite.prepare("SELECT attempt_count FROM project_memory_events WHERE id=?").get(f.eventId).attempt_count, 2);
});
test("a late memory attempt cannot write into or fail a newer processing attempt", async t => {
  const f = await fixture(t, row => row.sqlite.prepare("UPDATE project_memory_events SET attempt_count=attempt_count+1 WHERE id=?").run(row.eventId));
  await f.invoke("memory"); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 0);
  const event = f.sqlite.prepare("SELECT status,attempt_count,error_code FROM project_memory_events WHERE id=?").get(f.eventId);
  assert.equal(event.status, "processing"); assert.equal(event.attempt_count, 2); assert.equal(event.error_code, null);
});
test("operations within one extraction still deduplicate equivalent content and merge evidence", async t => {
  const f = await fixture(t, () => {}, [operations[0], { ...operations[0], canonicalKey: "input-alias", evidence: [{ sourceType: "manual", sourceId: "another-source", quote: operations[0].content }] }]);
  const response = await f.invoke("memory"); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_items").get().n, 1); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_evidence").get().n, 2);
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT value_json FROM project_memory_items").get().value_json).evidenceCount, 2);
});
test("revocation during the first event does not dispatch the next pending event", async t => {
  const f = await fixture(t, changes[0][1]);
  const nextId = f.seed("project_memory_events", { event_type: "manual", source_type: "manual", dedupe_key: "next", payload_hash: "next", created_at: "2026-10-12T00:00:00Z" });
  const response = await f.invoke("memory"); assert.equal(response.status, 403); assert.equal(f.calls.length, 1);
  const next = f.sqlite.prepare("SELECT status,attempt_count FROM project_memory_events WHERE id=?").get(nextId); assert.equal(next.status, "pending"); assert.equal(next.attempt_count, 0);
});
test("a reclaim between claim and source read does not send a model request or fail the new claim", async t => {
  const f = await fixture(t), prepare = f.db.prepare; let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql), first = statement.first; statement.first = async () => {
    if (!changed && sql.startsWith("SELECT * FROM project_memory_events")) { changed = true; f.sqlite.prepare("UPDATE project_memory_events SET attempt_count=attempt_count+1 WHERE id=?").run(f.eventId); }
    return first();
  }; return statement; };
  await f.invoke("memory"); assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM project_memory_events WHERE id=?").get(f.eventId).status, "processing");
});
test("failure after merging evidence rolls back the evidence and preserves existing memory metadata", async t => {
  const f = await fixture(t), rowId = f.seed("project_memory_items", { canonical_key: "prior", title: operations[0].title, content: operations[0].content, content_hash: await f.load("lib/project-memory-events.ts").sha256ProjectAssistantText(operations[0].content), category: "memory", kind: "soft", status: "confirmed", source_type: "manual", value_json: '{"humanNote":"保留人工记录","evidenceCount":0}' });
  const before = f.sqlite.prepare("SELECT * FROM project_memory_items WHERE id=?").get(rowId);
  f.sqlite.exec("CREATE TRIGGER injected_metadata_failure BEFORE UPDATE ON project_memory_items BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END;");
  await f.invoke("memory"); assert.deepEqual(f.sqlite.prepare("SELECT * FROM project_memory_items WHERE id=?").get(rowId), before); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_memory_evidence").get().n, 0);
});
test("revocation before the initial chat transaction creates no question, reply or paid request", async t => {
  const f = await fixture(t), prepare = f.db.prepare, batch = f.db.batch;
  f.db.prepare = sql => { const statement = prepare(sql); statement.auditSql = sql; return statement; };
  f.db.batch = async statements => { if (statements[0].auditSql?.startsWith("INSERT INTO project_assistant_messages")) changes[0][1](f); return batch(statements); };
  const response = await f.invoke("chat"); assert.equal(response.status, 403); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_assistant_messages").get().n, 0);
});
test("chat repair cannot swallow a permission failure even if membership is immediately restored", async t => {
  const f = await fixture(t, (row, count) => { if (count === 2) changes[0][1](row); }, operations, "请推荐三个系列选题"), prepare = f.db.prepare;
  f.db.prepare = sql => { const statement = prepare(sql), first = statement.first; statement.first = async () => {
    const result = await first();
    if (f.calls.length === 2 && sql.startsWith("SELECT 1 WHERE EXISTS") && !result) f.sqlite.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").run(f.scope.userId);
    return result;
  }; return statement; };
  const response = await f.invoke("chat"); assert.equal(response.status, 403, await response.clone().text()); assert.equal(f.calls.length, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE role='assistant' AND status='completed'").get().n, 0);
});
test("evidence merging repairs malformed metadata without discarding the memory or evidence", async t => {
  const f = await fixture(t), rowId = f.seed("project_memory_items", { canonical_key: "prior", title: operations[0].title, content: operations[0].content, content_hash: await f.load("lib/project-memory-events.ts").sha256ProjectAssistantText(operations[0].content), category: "memory", kind: "soft", status: "confirmed", source_type: "manual", value_json: "{" });
  const response = await f.invoke("memory"); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT status FROM project_memory_events WHERE id=?").get(f.eventId).status, "completed");
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT value_json FROM project_memory_items WHERE id=?").get(rowId).value_json).evidenceCount, 1);
});
test("evidence merging preserves metadata concurrently edited before the commit", async t => {
  const f = await fixture(t), rowId = f.seed("project_memory_items", { canonical_key: "prior", title: operations[0].title, content: operations[0].content, content_hash: await f.load("lib/project-memory-events.ts").sha256ProjectAssistantText(operations[0].content), category: "memory", kind: "soft", status: "confirmed", source_type: "manual", value_json: '{"humanNote":"原记录"}' }), batch = f.db.batch, prepare = f.db.prepare;
  let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql); statement.auditSql = sql; return statement; };
  f.db.batch = async statements => {
    if (!changed && statements.some(s => /INSERT INTO project_memory_evidence/.test(s.auditSql))) { changed = true; f.sqlite.prepare("UPDATE project_memory_items SET value_json=? WHERE id=?").run('{"humanNote":"同事刚修改的记录"}', rowId); }
    return batch(statements);
  };
  const response = await f.invoke("memory"); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT value_json FROM project_memory_items WHERE id=?").get(rowId).value_json).humanNote, "同事刚修改的记录");
});
test("a reclaim at model reservation sends no request and does not consume quota", async t => {
  const f = await fixture(t), prepare = f.db.prepare; let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql), run = statement.run; statement.run = async () => {
    if (!changed && sql.startsWith("INSERT INTO model_calls")) { changed = true; f.sqlite.prepare("UPDATE project_memory_events SET attempt_count=attempt_count+1 WHERE id=?").run(f.eventId); }
    return run();
  }; return statement; };
  const response = await f.invoke("memory"); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).results[0].error.code, "PROJECT_MEMORY_ATTEMPT_CHANGED");
  assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM project_memory_events WHERE id=?").get(f.eventId).status, "processing");
});
test("a reclaim during context reads is detected before starting a model request", async t => {
  const f = await fixture(t), prepare = f.db.prepare; let changed = false;
  f.db.prepare = sql => { const statement = prepare(sql), all = statement.all; statement.all = async () => {
    if (!changed && sql.includes("FROM project_memory_items")) { changed = true; f.sqlite.prepare("UPDATE project_memory_events SET attempt_count=attempt_count+1 WHERE id=?").run(f.eventId); }
    return all();
  }; return statement; };
  await f.invoke("memory"); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT status FROM project_memory_events WHERE id=?").get(f.eventId).status, "processing");
});
