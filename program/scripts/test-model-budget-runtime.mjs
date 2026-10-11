import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync, createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { splitSql } from "./sql-statements.mjs";

// Built Worker, real HTTP/password sessions/D1. Every outbound request is handled
// locally; this harness never reads .dev.vars or contacts a real model provider.
const root = fileURLToPath(new URL("..", import.meta.url));
const runDir = path.join(root, ".local/mb", randomBytes(4).toString("hex")); mkdirSync(runDir, { recursive: true });
const scope = { organizationId: "fee-org", projectId: "fee-project" }, userId = "fee-user";
const password = randomBytes(18).toString("base64url"), scenarios = [], requests = [], providerCalls = [];
let mf, db, origin, cookie, mode = "valid", modeCalls = 0, rewriteResponseHook, responseHook;
let assistantMemoryOperations = [{ operation: "noop", confidence: 100, reason: "没有新证据" }];
const audit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };
const source = "企业在2027年要让AI增长7.1%，我们会先把每次测试的过程记录下来，然后逐项核对结果，最后才决定怎样调整。";
const rewritten = "面向2027年AI增长7.1%的目标，我们先留下每轮测试的过程记录，核验各项结果以后，再据此安排后续调整。";
const setMode = next => { mode = next; modeCalls = 0; };
async function http(route, body, authenticated = true, method = body ? "POST" : "GET") {
  const start = performance.now();
  const response = await fetch(new URL(route, origin), { method, headers: { connection: "close", ...(body ? { "content-type": "application/json" } : {}), ...(authenticated && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const data = await response.json(); requests.push({ route, status: response.status, ms: Math.round(performance.now() - start) });
  return { status: response.status, headers: response.headers, data };
}
const expect = (response, status) => { assert.equal(response.status, status, JSON.stringify(response.data)); return response.data; };
async function check(name, action) { try { await action(); scenarios.push({ name, passed: true }); console.log(`PASS ${name}`); } catch (error) { scenarios.push({ name, passed: false, error: error.message }); throw error; } }
async function count() { return (await db.prepare("SELECT COUNT(*) n FROM model_calls").first()).n; }
async function allowance(extra) { await db.prepare("UPDATE organization_settings SET monthly_model_call_quota=(SELECT COUNT(*) FROM model_calls WHERE organization_id=?)+? WHERE organization_id=?").bind(scope.organizationId, extra, scope.organizationId).run(); }
const topic = () => http("/api/topics/generate", { ...scope, draft: { title: "如何核对工作结果" }, targets: ["angle"] });
const cpuStart = process.cpuUsage(), startedAt = new Date().toISOString();
try {
  const server = path.join(root, "dist/server"), config = JSON.parse(readFileSync(path.join(server, "wrangler.json"), "utf8"));
  mf = new Miniflare({
    host: "127.0.0.1", port: 0,
    modules: ["index.js", ...readdirSync(server, { recursive: true }).filter(file => file !== "index.js" && /\.m?js$/.test(file))].map(file => ({ type: "ESModule", path: path.join(server, file) })), modulesRoot: server,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: "model-budget-fixture" }, d1Persist: path.join(runDir, "d1"),
    r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, "r2"),
    assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
    bindings: { DELIVERY_MODE: "0", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0", LAN_MODE: "1", LAN_ACCESS_ORIGIN: "http://192.168.50.10:3000",
      CONTENT_MODEL_PROVIDER: "fixture", CONTENT_MODEL_NAME: "content-fixture", CONTENT_MODEL_BASE_URL: "https://model.example.invalid", CONTENT_MODEL_API_KEY: "synthetic-content-key",
      PROJECT_ASSISTANT_MODEL_PROVIDER: "independent-fixture", PROJECT_ASSISTANT_MODEL_NAME: "assistant-fixture", PROJECT_ASSISTANT_MODEL_BASE_URL: "https://assistant.example.invalid", PROJECT_ASSISTANT_MODEL_API_KEY: "synthetic-assistant-key" },
    outboundService: async request => {
      const url = new URL(request.url);
      if (!["model.example.invalid", "assistant.example.invalid"].includes(url.hostname) || url.pathname !== "/chat/completions") return new Response("External request blocked", { status: 502 });
      const payload = await request.json(); providerCalls.push({ host: url.hostname, model: payload.model, mode }); modeCalls += 1;
      if (mode === "offline") return Response.json({ error: { message: "Synthetic provider unavailable" } }, { status: 502 });
      let result = { angle: "先记录过程，再逐项核对结果" };
      const user = payload.messages.at(-1).content;
      let context; try { context = JSON.parse(user); } catch { /* Topic prompt has a prose prefix. */ }
      if (url.hostname === "assistant.example.invalid") result = { reply: "当前暂无对标资料，先从一个业务问题验证方向。", recommendations: [], citations: [], memoryOperations: assistantMemoryOperations };
      else if (context?.task) result = context.task === "audit_micro_homomorphic_script" ? audit : { paragraphs: context.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewritten })) };
      if (context?.task && rewriteResponseHook) await rewriteResponseHook(context);
      if (responseHook) await responseHook();
      return Response.json({ choices: [{ message: { content: mode === "invalid-first" && modeCalls === 1 ? "{" : JSON.stringify(result) } }], ...(mode === "unknown-usage" ? {} : { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) });
    },
  });
  origin = String(await mf.ready); db = await mf.getD1Database("DB");
  for (const filename of readdirSync(path.join(root, "drizzle")).filter(file => file.endsWith(".sql")).sort()) {
    for (const sql of splitSql(readFileSync(path.join(root, "drizzle", filename), "utf8"))) await db.prepare(sql).run();
  }
  const now = new Date().toISOString(), salt = randomBytes(16), hash = pbkdf2Sync(password, salt, 210000, 32, "sha256");
  await db.prepare("INSERT INTO users(id,auth_subject,email,display_name,status,created_at,updated_at) VALUES(?,?,?,'Fee fixture','active',?,?)").bind(userId, userId, "fee@example.invalid", now, now).run();
  await db.prepare("INSERT INTO local_credentials(user_id,password_salt,password_hash,iterations,created_at,updated_at) VALUES(?,?,?,210000,?,?)").bind(userId, salt.toString("base64url"), hash.toString("base64url"), now, now).run();
  await db.prepare("INSERT INTO organizations(id,name,slug,status,created_by,created_at,updated_at) VALUES(?,'Fee fixture','fee-fixture','active',?,?,?)").bind(scope.organizationId, userId, now, now).run();
  await db.prepare("INSERT INTO organization_members(id,organization_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('fee-member',?,?,'admin','active',?,?,?,?)").bind(scope.organizationId, userId, userId, userId, now, now).run();
  await db.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Fee project','Synthetic account',?,?,?,?)").bind(scope.projectId, scope.organizationId, userId, userId, now, now).run();
  await db.prepare("INSERT INTO content_strategies(id,organization_id,project_id,version,name,positioning,target_audience,status,pain_points_json,pillars_json,topic_mix_json,objectives_json,created_by,updated_by,created_at,updated_at) VALUES('fee-strategy',?,?,1,'Synthetic strategy','清楚核对任务结果','初学者','active','[]','[]','{}',?,?,?,?,?)").bind(scope.organizationId, scope.projectId, JSON.stringify(["教育"]), userId, userId, now, now).run();
  await check("password login and unauthenticated generation rejection", async () => {
    expect(await topic(), 401);
    const login = await http("/api/auth/session", { email: "fee@example.invalid", password }, false); expect(login, 200); cookie = login.headers.get("set-cookie").split(";")[0];
  });
  await check("topic repair records two actual requests", async () => {
    const before = await count(); setMode("invalid-first"); expect(await topic(), 200); assert.equal(await count() - before, 2);
    const row = await db.prepare("SELECT output_json FROM model_calls WHERE task_type='topic_fields'").first(); assert.equal(JSON.parse(row.output_json).modelRequests.length, 2);
  });
  await check("three HTTP callers share the final company budget slot", async () => {
    await allowance(1); setMode("valid"); const before = providerCalls.length; const responses = await Promise.all([topic(), topic(), topic()]);
    assert.equal(responses.filter(response => response.status === 200).length, 1); assert.equal(responses.filter(response => response.status === 429).length, 2); assert.equal(providerCalls.length - before, 1);
  });
  let conversationId;
  await check("assistant repair cannot exceed remaining budget and uses its own provider", async () => {
    await allowance(1); const before = providerCalls.length;
    const created = expect(await http("/api/project-assistant/conversations", scope), 201); conversationId = created.conversation?.id ?? created.id;
    assert.ok(conversationId, JSON.stringify(created));
    expect(await http(`/api/project-assistant/conversations/${conversationId}/messages`, { ...scope, question: "请推荐三个系列选题" }), 201);
    assert.equal(providerCalls.length - before, 1); assert.equal(providerCalls.at(-1).host, "assistant.example.invalid");
  });
  await check("status viewing is free, explicit connection probe consumes one request", async () => {
    const before = providerCalls.length;
    expect(await http(`/api/project-assistant/status?organizationId=${scope.organizationId}&projectId=${scope.projectId}`), 200); assert.equal(providerCalls.length, before);
    expect(await http("/api/project-assistant/status", scope), 429); assert.equal(providerCalls.length, before);
    await allowance(1); expect(await http("/api/project-assistant/status", scope), 200); assert.equal(providerCalls.length - before, 1);
  });
  await check("memory extraction enters the same request ledger", async () => {
    await allowance(1);
    await db.prepare("INSERT INTO project_memory_events(id,organization_id,project_id,event_type,source_type,source_id,dedupe_key,payload_hash,payload_json,status,created_by,created_at,updated_at) VALUES('fee-event',?,?,'manual','manual','synthetic','synthetic','synthetic','{}','pending',?,?,?)").bind(scope.organizationId, scope.projectId, userId, now, now).run();
    const before = providerCalls.length; const result = expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200);
    assert.equal(result.results[0].status, "completed"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM model_calls WHERE task_type='project_assistant.memory'").first()).n, 1);
  });
  await check("rewrite JSON repair and audit preserve all three request token totals", async () => {
    await allowance(10); setMode("invalid-first");
    await db.prepare("INSERT INTO script_rewrite_workspaces(id,organization_id,project_id,title,source_type,source_label,source_text,source_hash,source_character_count,created_by,updated_by,created_at,updated_at) VALUES('fee-rewrite',?,?,'Synthetic','pasted','Synthetic',?,'synthetic',?,?,?,?,?)").bind(scope.organizationId, scope.projectId, source, source.length, userId, userId, now, now).run();
    await db.prepare("INSERT INTO script_rewrite_versions(id,organization_id,project_id,workspace_id,version,variant,text,created_by,created_at) VALUES('fee-source',?,?,'fee-rewrite',1,'source',?,?,?)").bind(scope.organizationId, scope.projectId, source, userId, now).run();
    const before = providerCalls.length; expect(await http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), 201);
    assert.equal(providerCalls.length - before, 3); assert.equal((await db.prepare("SELECT actual_total_tokens FROM script_rewrite_runs").first()).actual_total_tokens, 24);
  });
  await check("exhausted budget preserves the last rewrite version", async () => {
    await allowance(0); const before = providerCalls.length;
    expect(await http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), 429); assert.equal(providerCalls.length, before);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM script_rewrite_versions WHERE workspace_id='fee-rewrite'").first()).n, 2);
  });
  await check("provider HTTP failure remains counted with unknown usage", async () => {
    await allowance(1); setMode("offline"); const before = await count(); expect(await topic(), 502); assert.equal(await count() - before, 1);
    const row = await db.prepare("SELECT output_json FROM model_calls WHERE status='failed' ORDER BY created_at DESC LIMIT 1").first(); assert.equal(JSON.parse(row.output_json).modelRequests[0].usageKnown, false);
  });
  await check("cross-company attempts do not spend model budget", async () => {
    const before = providerCalls.length; expect(await http("/api/topics/generate", { ...scope, organizationId: "foreign", draft: { title: "Synthetic" }, targets: ["angle"] }), 403); assert.equal(providerCalls.length, before);
    assert.equal(await count(), providerCalls.length);
  });
  await check("rewrite detail distinguishes missing provider usage from zero consumption", async () => {
    await allowance(10); setMode("unknown-usage"); const before = providerCalls.length;
    const generated = expect(await http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), 201);
    const detail = expect(await http(`/api/script-rewrites/fee-rewrite?organizationId=${scope.organizationId}&projectId=${scope.projectId}`), 200);
    const run = detail.runs.find(run => run.id === generated.results[0].runId);
    assert.equal(run.actualTotalTokens, 0); assert.equal(run.unknownRequestCount, providerCalls.length - before); assert.ok(run.unknownRequestCount > 0);
    assert.equal(await count(), providerCalls.length);
  });
  await check("concurrent generated replies retain every independent version and matching audit", async () => {
    await allowance(20); setMode("valid"); const before = providerCalls.length;
    const replies = await Promise.all(Array.from({ length: 3 }, () => http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] })));
    const results = replies.map(reply => expect(reply, 201).results[0]);
    assert.equal(new Set(results.map(result => result.version)).size, 3); assert.equal(providerCalls.length - before, 6);
    for (const result of results) {
      const row = await db.prepare("SELECT v.version,r.status,r.result_version_id,a.metadata_json FROM script_rewrite_versions v INNER JOIN script_rewrite_runs r ON r.id=v.run_id INNER JOIN audit_logs a ON a.target_id=v.id AND a.action='script_rewrite.generated' WHERE v.id=?").bind(result.versionId).first();
      assert.equal(row.version, result.version); assert.equal(row.status, "completed"); assert.equal(row.result_version_id, result.versionId); assert.equal(JSON.parse(row.metadata_json).version, row.version);
    }
  });
  await check("five concurrent manual HTTP saves preserve all submitted drafts", async () => {
    const before = providerCalls.length, bodies = Array.from({ length: 5 }, (_, index) => `并发人工稿${index}：${source}`);
    const replies = await Promise.all(bodies.map(text => http("/api/script-rewrites/fee-rewrite", { ...scope, parentVersionId: "fee-source", text }, true, "PATCH")));
    const results = replies.map(reply => expect(reply, 201).version);
    assert.equal(new Set(results.map(result => result.version)).size, 5); assert.equal(providerCalls.length, before);
    const rows = (await db.prepare("SELECT text FROM script_rewrite_versions WHERE workspace_id='fee-rewrite' AND variant='manual'").all()).results;
    assert.deepEqual(new Set(rows.map(row => row.text)), new Set(bodies));
  });
  await check("company membership revoked during the provider reply blocks subsequent spend and result writes", async () => {
    await allowance(10); const before = providerCalls.length;
    const versions = (await db.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").first()).n;
    rewriteResponseHook = async () => { rewriteResponseHook = undefined; await db.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").bind(userId).run(); };
    const data = expect(await http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), 207);
    assert.equal(data.results[0].error.code, "REWRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").first()).n, versions);
    assert.equal((await db.prepare("SELECT actual_total_tokens FROM script_rewrite_runs WHERE id=?").bind(data.results[0].runId).first()).actual_total_tokens, 8);
    await db.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").bind(userId).run();
  });
  await check("session revocation during the final audit refuses the late version and requires a fresh login", async () => {
    const before = providerCalls.length, versions = (await db.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").first()).n;
    rewriteResponseHook = async context => { if (context.task === "audit_micro_homomorphic_script") { rewriteResponseHook = undefined; await db.prepare("DELETE FROM local_sessions WHERE user_id=?").bind(userId).run(); } };
    const data = expect(await http("/api/script-rewrites/fee-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), 207);
    assert.equal(data.results[0].error.code, "REWRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").first()).n, versions);
    expect(await http(`/api/script-rewrites/fee-rewrite?organizationId=${scope.organizationId}&projectId=${scope.projectId}`), 401);
    const login = await http("/api/auth/session", { email: "fee@example.invalid", password }, false); expect(login, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    expect(await http(`/api/script-rewrites/fee-rewrite?organizationId=${scope.organizationId}&projectId=${scope.projectId}`), 200);
    assert.equal(await count(), providerCalls.length);
  });
  await check("topic reply after membership removal is denied and the actual request remains counted", async () => {
    await allowance(10); const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").bind(userId).run(); };
    const data = expect(await topic(), 403); assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    await db.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").bind(userId).run();
  });
  await check("image copy reply after project archival is denied without repair or a success audit", async () => {
    const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE projects SET status='archived' WHERE id=?").bind(scope.projectId).run(); };
    const data = expect(await http("/api/wechat-images/generate", { ...scope, topic: "如何核对工作结果", templateId: "method-warm", ratioId: "3:4" }), 403);
    assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='wechat_image.generated'").first()).n, 0);
    await db.prepare("UPDATE projects SET status='active' WHERE id=?").bind(scope.projectId).run();
  });
  await check("content reply after membership removal cannot create a version or overwrite the old draft", async () => {
    await db.prepare("INSERT INTO topic_ideas(id,organization_id,project_id,title,source_type,created_by,updated_by,created_at,updated_at) VALUES('fee-topic',?,?,'如何核对任务','manual',?,?,?,?)").bind(scope.organizationId, scope.projectId, userId, userId, now, now).run();
    await db.prepare("INSERT INTO content_items(id,organization_id,project_id,topic_id,title,created_by,updated_by,created_at,updated_at) VALUES('fee-content',?,?,'fee-topic','Synthetic content',?,?,?,?)").bind(scope.organizationId, scope.projectId, userId, userId, now, now).run();
    await db.prepare("INSERT INTO content_versions(id,organization_id,project_id,content_item_id,version,generation_mode,pack_json,full_script,short_script,created_by,created_at) VALUES('fee-original',?,?,'fee-content',1,'manual','{}',?,'保留原稿',?,?)").bind(scope.organizationId, scope.projectId, source, userId, now).run();
    const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").bind(userId).run(); };
    const data = expect(await http("/api/content-items/fee-content/generate", { ...scope }), 403);
    assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT current_version FROM content_items WHERE id='fee-content'").first()).current_version, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM content_versions WHERE content_item_id='fee-content'").first()).n, 1);
    assert.equal((await db.prepare("SELECT full_script FROM content_versions WHERE id='fee-original'").first()).full_script, source);
    await db.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").bind(userId).run();
  });
  await check("topic response after real session deletion is denied and fresh login remains usable", async () => {
    const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("DELETE FROM local_sessions WHERE user_id=?").bind(userId).run(); };
    const data = expect(await topic(), 403); assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    const login = await http("/api/auth/session", { email: "fee@example.invalid", password }, false); expect(login, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    expect(await topic(), 200);
    assert.equal(await count(), providerCalls.length);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM model_calls WHERE error_code='PROJECT_WRITE_ACCESS_CHANGED'").first()).n, 4);
  });
  await check("assistant chat after membership revocation refuses output and leaves a failed durable reply", async () => {
    await allowance(20); const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").bind(userId).run(); };
    const data = expect(await http(`/api/project-assistant/conversations/${conversationId}/messages`, { ...scope, question: "请说明怎样核对一个业务问题" }), 403);
    assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE conversation_id=? AND error_code='PROJECT_WRITE_ACCESS_CHANGED' AND status='failed'").bind(conversationId).first()).n, 1);
    await db.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").bind(userId).run();
  });
  await check("paid assistant probe after session deletion is refused and retains its ledger", async () => {
    const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("DELETE FROM local_sessions WHERE user_id=?").bind(userId).run(); };
    const data = expect(await http("/api/project-assistant/status", scope), 403); assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    const login = await http("/api/auth/session", { email: "fee@example.invalid", password }, false); expect(login, 200); cookie = login.headers.get("set-cookie").split(";")[0];
  });
  const addMemoryEvent = async (id, author = userId, createdAt = now) => db.prepare("INSERT INTO project_memory_events(id,organization_id,project_id,event_type,source_type,source_id,dedupe_key,payload_json,payload_hash,created_by,created_at,updated_at) VALUES(?,?,?,'manual','manual',?,?,'{}','synthetic',?,?,?)").bind(id, scope.organizationId, scope.projectId, id, id, author, createdAt, createdAt).run();
  await check("current admin syncs a disabled historical author's source and owns the paid request", async () => {
    await db.prepare("INSERT INTO users(id,auth_subject,email,display_name,status,created_at,updated_at) VALUES('historical-author','historical-author','old@example.invalid','Historical','disabled',?,?)").bind(now, now).run();
    await addMemoryEvent("memory-historical", "historical-author");
    expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200);
    assert.equal((await db.prepare("SELECT status FROM project_memory_events WHERE id='memory-historical'").first()).status, "completed");
    assert.equal((await db.prepare("SELECT created_by FROM model_calls WHERE json_extract(input_json,'$.sourceId')='memory-historical'").first()).created_by, userId);
  });
  await check("memory revocation refuses all candidates and leaves the next event pending", async () => {
    await addMemoryEvent("memory-denied", userId, "2026-01-01T00:00:00Z"); await addMemoryEvent("memory-next", userId, "2026-02-01T00:00:00Z"); const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").bind(userId).run(); };
    const data = expect(await http("/api/project-memory/sync", { ...scope, limit: 3 }), 403); assert.equal(data.error.code, "PROJECT_WRITE_ACCESS_CHANGED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT status FROM project_memory_events WHERE id='memory-next'").first()).status, "pending");
    await db.prepare("UPDATE organization_members SET status='active' WHERE user_id=?").bind(userId).run();
    await db.prepare("UPDATE project_memory_events SET status='completed' WHERE id IN ('memory-denied','memory-next')").run(); // End these isolated scenario fixtures.
  });
  await check("D1 rolls back every memory operation on late evidence failure and explicit retry succeeds", async () => {
    assistantMemoryOperations = [
      { operation: "add", canonicalKey: "runtime-input", title: "输入责任", content: "任务开始前约定由谁提供输入资料，减少等待与返工。", confidence: 90, evidence: [{ sourceType: "manual", sourceId: "runtime-first" }] },
      { operation: "add", canonicalKey: "runtime-review", title: "复查时间", content: "审核时约定复查日期，按截止时间安排审核人员。", confidence: 90, evidence: [{ sourceType: "manual", sourceId: "runtime-second" }] },
    ];
    await addMemoryEvent("memory-atomic", userId, "2000-01-01T00:00:00Z");
    await db.prepare("CREATE TRIGGER injected_runtime_evidence BEFORE INSERT ON project_memory_evidence WHEN NEW.source_id='runtime-second' BEGIN SELECT RAISE(ABORT,'Synthetic evidence failure'); END").run();
    const failed = expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200); assert.equal(failed.results[0].status, "failed");
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_items WHERE source_id='memory-atomic'").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_evidence").first()).n, 0);
    await db.prepare("DROP TRIGGER injected_runtime_evidence").run();
    const retried = expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200); assert.equal(retried.results[0].status, "completed");
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_items WHERE source_id='memory-atomic'").first()).n, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_evidence").first()).n, 2);
    assert.equal((await db.prepare("SELECT attempt_count FROM project_memory_events WHERE id='memory-atomic'").first()).attempt_count, 2);
  });
  await check("late memory output cannot write into a newer processing attempt", async () => {
    await addMemoryEvent("memory-late", userId, "1999-01-01T00:00:00Z"); const before = providerCalls.length;
    responseHook = async () => { responseHook = undefined; await db.prepare("UPDATE project_memory_events SET attempt_count=attempt_count+1 WHERE id='memory-late'").run(); };
    const data = expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200); assert.equal(data.results[0].error.code, "PROJECT_MEMORY_ATTEMPT_CHANGED");
    assert.equal(providerCalls.length - before, 1); assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_items WHERE source_id='memory-late'").first()).n, 0);
    const event = await db.prepare("SELECT status,attempt_count,error_code FROM project_memory_events WHERE id='memory-late'").first(); assert.equal(event.status, "processing"); assert.equal(event.attempt_count, 2); assert.equal(event.error_code, null);
    assert.equal(await count(), providerCalls.length);
  });
  await check("archiving through HTTP while a provider responds cancels reply and prevents paid repair", async () => {
    await allowance(10); const before = providerCalls.length;
    responseHook = async () => {
      responseHook = undefined;
      expect(await http(`/api/project-assistant/conversations/${conversationId}?organizationId=${scope.organizationId}&projectId=${scope.projectId}`, undefined, true, "DELETE"), 200);
      assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE conversation_id=? AND role='assistant' AND status='processing'").bind(conversationId).first()).n, 0);
    };
    const result = expect(await http(`/api/project-assistant/conversations/${conversationId}/messages`, { ...scope, question: "请推荐三个系列选题" }), 409);
    assert.equal(result.error.code, "PROJECT_ASSISTANT_CHAT_INTERRUPTED"); assert.equal(providerCalls.length - before, 1);
    assert.equal((await db.prepare("SELECT status FROM project_assistant_conversations WHERE id=?").bind(conversationId).first()).status, "archived");
    assert.equal(await count(), providerCalls.length);
  });
  const atomScope = { ...scope, projectId: "atom-project" };
  await db.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Atoms','Synthetic',?,?,?,?)").bind(atomScope.projectId, scope.organizationId, userId, userId, now, now).run();
  await db.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,status,created_by,updated_by,created_at,updated_at) VALUES('atom-video',?,?,'upload','upload','ready',?,?,?,?)").bind(scope.organizationId, atomScope.projectId, userId, userId, now, now).run();
  await db.prepare("INSERT INTO video_library_entries(id,organization_id,source_video_id,created_by,updated_by,created_at,updated_at) VALUES('atom-entry',?,'atom-video',?,?,?,?)").bind(scope.organizationId, userId, userId, now, now).run();
  await db.prepare("INSERT INTO project_video_references(id,organization_id,project_id,library_entry_id,purpose,status,created_by,created_at) VALUES('atom-ref',?,?,'atom-entry','benchmark','active',?,?)").bind(scope.organizationId, atomScope.projectId, userId, now).run();
  await db.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES('atom-analysis',?,?,'atom-video','synthetic',?,?,?,?)").bind(scope.organizationId, atomScope.projectId, JSON.stringify({ summary: "核对任务输入", hook: "先检查资料" }), userId, now, now).run();
  await check("D1 atom failure rolls back all writes and exposes incomplete backfill without paid calls", async () => {
    const before = providerCalls.length;
    await db.prepare("CREATE TRIGGER fail_runtime_atom BEFORE INSERT ON video_knowledge_atoms WHEN NEW.atom_key='hook:0' BEGIN SELECT RAISE(ABORT,'Synthetic atom failure'); END").run();
    const result = expect(await http("/api/project-memory/sync", atomScope), 200);
    assert.equal(result.atomBackfill.failed, 1); assert.equal(result.results.length, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms WHERE library_entry_id='atom-entry'").first()).n, 0);
    assert.equal(providerCalls.length, before); await db.prepare("DROP TRIGGER fail_runtime_atom").run();
  });
  await check("concurrent HTTP backfill on one report reuses D1 atoms and makes no paid calls", async () => {
    const before = providerCalls.length;
    const results = await Promise.all([http("/api/project-memory/sync", atomScope), http("/api/project-memory/sync", atomScope), http("/api/project-memory/sync", atomScope)]);
    for (const response of results) { const result = expect(response, 200); assert.equal(result.atomBackfill.failed, 0); assert.equal(result.results.length, 0); }
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM video_knowledge_atoms WHERE library_entry_id='atom-entry' AND status='active'").first()).n, 2);
    assert.equal(providerCalls.length, before); assert.equal(await count(), providerCalls.length);
  });
} catch (error) { console.error(error.stack); if (error.cause) console.error(error.cause); process.exitCode = 1; }
finally {
  if (mf) await mf.dispose();
  const timings = requests.map(request => request.ms).sort((a, b) => a - b);
  const report = { passed: !process.exitCode && scenarios.length === 28 && scenarios.every(scenario => scenario.passed), startedAt, finishedAt: new Date().toISOString(),
    boundary: "Built Worker, real HTTP/password/D1; locally mocked providers, synthetic accounts/materials/token usage; no real model spend or multi-device business acceptance.",
    buildSha256: createHash("sha256").update(readFileSync(path.join(root, "dist/server/index.js"))).digest("hex"), scenarios, providerCalls, requests,
    metrics: { requests: requests.length, providerRequests: providerCalls.length, p50Ms: timings[Math.floor(timings.length * .5)] ?? 0, p95Ms: timings[Math.floor(timings.length * .95)] ?? 0, maxMs: timings.at(-1) ?? 0,
      harnessRssBytes: process.memoryUsage().rss, harnessCpuMicroseconds: process.cpuUsage(cpuStart), resourceBoundary: "Node harness only; excludes workerd and real supplier resources." } };
  writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, metrics: report.metrics, evidence: path.join(runDir, "report.json") }));
}
