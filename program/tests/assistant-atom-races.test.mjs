import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

class AssistantError extends Error { constructor(message, code) { super(message); this.code = code; } }
async function fixture(t, hook = () => {}) {
  const f = await contentGenerationFixture(t), calls = [];
  const organizationId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id=?").get(f.contentId).organization_id;
  const scope = { organizationId, projectId: "project", userId: f.identity.userId };
  f.mock("lib/project-assistant-model.ts", { ProjectAssistantConfigurationError: class extends Error {}, ProjectAssistantRequestError: AssistantError,
    readProjectAssistantModelConfig: () => ({ provider: "independent", model: "synthetic" }), projectAssistantConfigurationStatus: () => ({ configured: true }),
    invokeProjectAssistantModel: async () => { calls.push({}); await hook(f); return { provider: "independent", model: "synthetic", latencyMs: 1, raw: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, content: '{"reply":"请先明确输入和审核标准。","recommendations":[],"citations":[],"memoryOperations":[{"operation":"noop","confidence":100,"reason":"没有新证据"}]}' }; },
  });
  const conversation = await f.load("lib/project-assistant-conversation.ts").createProjectAssistantConversationWithDb(f.db, scope);
  const chat = () => f.load("app/api/project-assistant/conversations/[conversationId]/messages/route.ts").POST(f.request({ question: "请推荐三个系列选题" }), { params: Promise.resolve({ conversationId: conversation.id }) });
  const archive = () => f.load("app/api/project-assistant/conversations/[conversationId]/route.ts").DELETE(new Request(`http://localhost/api/project-assistant/conversations/${conversation.id}?organizationId=${organizationId}&projectId=project`, { method: "DELETE" }), { params: Promise.resolve({ conversationId: conversation.id }) });
  const sync = () => f.load("app/api/project-memory/sync/route.ts").POST(f.request({ limit: 3 }));
  const addVideo = (id = "video", createdAt = "2026-10-10T00:00:00Z") => {
    f.seed("videos", { id, platform: "upload", source_type: "upload", status: "ready" });
    f.seed("video_library_entries", { id: "entry-" + id, source_video_id: id });
    f.seed("project_video_references", { library_entry_id: "entry-" + id, purpose: "benchmark", status: "active", created_at: createdAt });
    const reportJson = JSON.stringify({ summary: "输入资料与审核标准需要逐项核对。", confidence: 90 });
    f.seed("video_analyses", { id: "analysis-" + id, video_id: id, schema_version: "synthetic", report_json: reportJson, created_at: createdAt });
    return { organizationId, videoId: id, analysisId: "analysis-" + id, reportJson };
  };
  const extract = input => f.load("lib/video-knowledge-atoms.ts").extractVideoKnowledgeAtoms(input);
  Object.assign(f, { scope, conversation, chat, archive, sync, addVideo, extract, calls });
  return f;
}
test("archiving a waiting chat stops repair, preserves fees and does not change the archived timestamp", async t => {
  const f = await fixture(t, async row => { assert.equal((await row.archive()).status, 200); row.sqlite.prepare("UPDATE project_assistant_conversations SET updated_at='2026-01-01T00:00:00Z' WHERE id=?").run(row.conversation.id); });
  const response = await f.chat(); assert.equal(response.status, 409, await response.clone().text()); assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT updated_at FROM project_assistant_conversations WHERE id=?").get(f.conversation.id).updated_at, "2026-01-01T00:00:00Z");
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT output_json FROM model_calls").get().output_json).modelRequests[0].totalTokens, 5);
});
test("archiving during quota reservation sends no request and consumes no slot", async t => {
  const f = await fixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => { const statement = prepare(sql), run = statement.run; statement.run = async () => { if (sql.startsWith("INSERT INTO model_calls")) f.sqlite.prepare("UPDATE project_assistant_conversations SET status='archived' WHERE id=?").run(f.conversation.id); return run(); }; return statement; };
  assert.equal((await f.chat()).status, 409); assert.equal(f.calls.length, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
});
test("archive immediately ends the durable pending reply before a held provider returns", async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { enter(); await held; }), attempt = f.chat(); await entered;
  const archived = await f.archive(); const pending = f.sqlite.prepare("SELECT status,error_code FROM project_assistant_messages WHERE role='assistant'").get(); release(); const response = await attempt;
  assert.equal(archived.status, 200); assert.equal(pending.status, "failed"); assert.equal(pending.error_code, "PROJECT_ASSISTANT_CHAT_INTERRUPTED"); assert.equal(response.status, 409); assert.equal(f.calls.length, 1);
});
test("revocation in the archive write prevents archiving or cancelling the reply", async t => {
  const f = await fixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => { if (sql.includes("UPDATE project_assistant_conversations SET status")) f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.scope.userId); return prepare(sql); };
  const response = await f.archive(); assert.equal(response.status, 403); assert.equal(f.sqlite.prepare("SELECT status FROM project_assistant_conversations WHERE id=?").get(f.conversation.id).status, "active");
});
test("revocation during the archive transaction leaves the conversation active", async t => {
  const f = await fixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => { const statement = prepare(sql), execute = statement.execute; statement.execute = () => { if (sql.includes("UPDATE project_assistant_conversations SET status")) f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.scope.userId); return execute(); }; return statement; };
  const response = await f.archive(); assert.equal(response.status, 403); assert.equal(f.sqlite.prepare("SELECT status FROM project_assistant_conversations WHERE id=?").get(f.conversation.id).status, "active");
});
test("revocation at legacy requeue preserves the completed source and its metadata", async t => {
  const f = await fixture(t), eventId = f.seed("project_memory_events", { event_type: "video_analysis_completed", source_type: "video_analysis", source_id: "missing-analysis", dedupe_key: "legacy", payload_hash: "legacy", status: "completed", prompt_version: "old-version", operation_summary_json: '[{"reason":"保留历史"}]' }), before = f.sqlite.prepare("SELECT * FROM project_memory_events WHERE id=?").get(eventId), prepare = f.db.prepare;
  f.db.prepare = sql => { const statement = prepare(sql), run = statement.run; statement.run = async () => { if (sql.includes("SELECT legacy.id")) f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.scope.userId); return run(); }; return statement; };
  assert.equal((await f.sync()).status, 403); assert.deepEqual(f.sqlite.prepare("SELECT * FROM project_memory_events WHERE id=?").get(eventId), before); assert.equal(f.calls.length, 0);
});
for (const change of ["membership", "assignment", "project", "reference"]) test(`knowledge backfill: ${change} changed at commit leaves no atoms`, async t => {
  const f = await fixture(t); f.addVideo(); const prepare = f.db.prepare, batch = f.db.batch;
  if (change === "assignment") { f.sqlite.prepare("UPDATE organization_members SET role='employee' WHERE user_id=?").run(f.scope.userId); f.seed("project_members", { user_id: f.scope.userId, role: "editor", status: "active" }); }
  f.db.prepare = sql => { const s = prepare(sql); s.auditSql = sql; return s; };
  f.db.batch = async statements => {
    if (statements.some(s => s.auditSql?.startsWith("INSERT INTO video_knowledge_atoms"))) {
      if (change === "membership") f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.scope.userId);
      if (change === "assignment") f.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(f.scope.userId);
      if (change === "project") f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id='project'").run();
      if (change === "reference") f.sqlite.prepare("UPDATE project_video_references SET status='revoked'").run();
    }
    return batch(statements);
  };
  const response = await f.sync(); assert.equal(response.status, change === "reference" ? 200 : 403, await response.clone().text()); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms").get().n, 0); assert.equal(f.calls.length, 0);
});
test("repeating atom extraction of one report reuses the same rows", async t => {
  const f = await fixture(t), input = f.addVideo(); await f.extract(input); const before = f.sqlite.prepare("SELECT * FROM video_knowledge_atoms").all();
  assert.equal((await f.extract(input)).status, "completed"); assert.deepEqual(f.sqlite.prepare("SELECT * FROM video_knowledge_atoms").all(), before);
});
test("concurrent atom extraction of one report completes once without unique-key failure", async t => {
  const f = await fixture(t), input = f.addVideo(); const results = await Promise.all([f.extract(input), f.extract(input), f.extract(input)]);
  assert.ok(results.every(row => row.status === "completed")); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms WHERE status='active'").get().n, 1);
});
test("a late old report cannot add atoms after a newer report is accepted", async t => {
  const f = await fixture(t), input = f.addVideo();
  f.seed("video_analyses", { id: "new-analysis", video_id: input.videoId, schema_version: "synthetic", report_json: '{"summary":"这是已经确认的新分析结果。"}', created_at: "2026-10-11T00:00:00Z" });
  const result = await f.extract(input); assert.equal(result.status, "stale"); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms").get().n, 0);
});
test("a newer report arriving just before the atom batch rejects the old snapshot", async t => {
  const f = await fixture(t), input = f.addVideo(), prepare = f.db.prepare, batch = f.db.batch; let injected = false;
  f.db.prepare = sql => { const s = prepare(sql); s.auditSql = sql; return s; };
  f.db.batch = async statements => {
    if (!injected && statements.some(s => s.auditSql?.startsWith("INSERT INTO video_knowledge_atoms"))) { injected = true; f.seed("video_analyses", { id: "new-analysis", video_id: input.videoId, schema_version: "synthetic", report_json: '{"summary":"新的分析"}', created_at: "2026-10-11T00:00:00Z" }); }
    return batch(statements);
  };
  assert.equal((await f.extract(input)).status, "stale"); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms").get().n, 0);
});
test("old extraction cannot supersede the new winner during a racing replacement", async t => {
  const f = await fixture(t), input = f.addVideo(); await f.extract(input);
  const older = { ...input, analysisId: "analysis-older", reportJson: '{"summary":"较早的修订报告"}' };
  f.seed("video_analyses", { id: older.analysisId, video_id: input.videoId, schema_version: "synthetic", report_json: older.reportJson, created_at: "2026-10-10T01:00:00Z" });
  const prepare = f.db.prepare, batch = f.db.batch; let injected = false;
  f.db.prepare = sql => { const s = prepare(sql); s.auditSql = sql; return s; };
  f.db.batch = async statements => {
    if (!injected && statements.some(s => s.auditSql?.startsWith("INSERT INTO video_knowledge_atoms"))) {
      injected = true; const newer = { ...input, analysisId: "analysis-newer", reportJson: '{"summary":"最终确认的新报告"}' };
      f.seed("video_analyses", { id: newer.analysisId, video_id: input.videoId, schema_version: "synthetic", report_json: newer.reportJson, created_at: "2026-10-10T02:00:00Z" }); await f.extract(newer);
    }
    return batch(statements);
  };
  assert.equal((await f.extract(older)).status, "stale"); assert.deepEqual(f.sqlite.prepare("SELECT analysis_id FROM video_knowledge_atoms WHERE status='active'").all().map(row => row.analysis_id), ["analysis-newer"]);
});
test("active chat keeps its ordinary two-request suggestion repair", async t => {
  const f = await fixture(t), response = await f.chat(); assert.equal(response.status, 201, await response.clone().text()); assert.equal(f.calls.length, 2);
});
test("active benchmark backfill succeeds without calling a model", async t => {
  const f = await fixture(t); f.addVideo(); const response = await f.sync(); assert.equal(response.status, 200, await response.clone().text()); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms WHERE status='active'").get().n, 1); assert.equal(f.calls.length, 0);
});

test("atom batch failure rolls back new rows and preserves the old active snapshot", async t => {
  const f = await fixture(t), input = f.addVideo(); await f.extract(input);
  const before = f.sqlite.prepare("SELECT * FROM video_knowledge_atoms").all();
  const next = { ...input, analysisId: "analysis-next", reportJson: '{"summary":"新摘要","hook":"新开头"}' };
  f.seed("video_analyses", { id: next.analysisId, video_id: input.videoId, schema_version: "synthetic", report_json: next.reportJson, created_at: "2026-10-11T00:00:00Z" });
  f.sqlite.exec("CREATE TRIGGER fail_atom BEFORE INSERT ON video_knowledge_atoms WHEN NEW.atom_key='hook:0' BEGIN SELECT RAISE(ABORT,'synthetic atom failure'); END");
  await assert.rejects(f.extract(next), /synthetic atom failure/); assert.deepEqual(f.sqlite.prepare("SELECT * FROM video_knowledge_atoms").all(), before);
  f.sqlite.exec("DROP TRIGGER fail_atom"); assert.equal((await f.extract(next)).status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms WHERE status='active'").get().n, 2);
});

test("report JSON changed on the same analysis id rejects its old contents", async t => {
  const f = await fixture(t), input = f.addVideo();
  f.sqlite.prepare("UPDATE video_analyses SET report_json=? WHERE id=?").run('{"summary":"已经修改"}', input.analysisId);
  assert.equal((await f.extract(input)).status, "stale"); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms").get().n, 0);
});

test("same-time newer analysis wins deterministically over the old report", async t => {
  const f = await fixture(t), input = f.addVideo();
  f.seed("video_analyses", { id: "same-time-new", video_id: input.videoId, schema_version: "synthetic", report_json: '{"summary":"同一时刻的后续报告"}', created_at: "2026-10-10T00:00:00Z" });
  assert.equal((await f.extract(input)).status, "stale"); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms").get().n, 0);
});
