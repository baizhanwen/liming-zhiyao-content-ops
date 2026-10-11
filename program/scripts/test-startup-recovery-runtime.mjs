import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync, createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { splitSql } from "./sql-statements.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)), self = fileURLToPath(import.meta.url);
const scope = { organizationId: "restart-org", projectId: "restart-project" }, userId = "restart-user";
const source = "企业在2027年要让AI增长7.1%，我们会先把每次测试的过程记录下来，然后逐项核对结果，最后才决定怎样调整。";
const rewritten = "面向2027年AI增长7.1%的目标，我们先留下每轮测试的过程记录，核验各项结果以后，再据此安排后续调整。";
const audit = { missing_paragraph_ids: [], problem_paragraph_ids: [], added_claims: [], core_information_retention: 100, structure_aligned: true, style_aligned: true, conclusion_aligned: true, production_notes_preserved: true, copy_risk: "low", notes: [] };
const deadline = (promise, ms = 20000) => {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic process observation timed out")), ms); })]).finally(() => clearTimeout(timer));
};

async function child(runDir, hold) {
  const server = path.join(root, "dist/server"), config = JSON.parse(readFileSync(path.join(server, "wrangler.json"), "utf8"));
  const mf = new Miniflare({ host: "127.0.0.1", port: 0,
    modules: ["index.js", ...readdirSync(server, { recursive: true }).filter(file => file !== "index.js" && /\.m?js$/.test(file))].map(file => ({ type: "ESModule", path: path.join(server, file) })), modulesRoot: server,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: "00000000-0000-4000-8000-000000000000" }, d1Persist: path.join(runDir, ".wrangler/state/v3/d1"),
    r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist: path.join(runDir, ".wrangler/state/v3/r2"),
    assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
    bindings: { DELIVERY_MODE: "0", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0", LAN_MODE: "1", LAN_ACCESS_ORIGIN: "http://192.168.50.10:3000",
      CONTENT_MODEL_PROVIDER: "fixture", CONTENT_MODEL_NAME: "restart-fixture", CONTENT_MODEL_BASE_URL: "https://model.example.invalid", CONTENT_MODEL_API_KEY: "synthetic-only",
      PROJECT_ASSISTANT_MODEL_PROVIDER: "fixture", PROJECT_ASSISTANT_MODEL_NAME: "restart-assistant", PROJECT_ASSISTANT_MODEL_BASE_URL: "https://assistant.example.invalid", PROJECT_ASSISTANT_MODEL_API_KEY: "synthetic-only" },
    outboundService: async request => {
      const url = new URL(request.url); if (!["model.example.invalid", "assistant.example.invalid"].includes(url.hostname)) return new Response("External access blocked", { status: 502 });
      const input = await request.json(), payload = JSON.parse(input.messages.at(-1).content);
      process.send({ event: "provider", task: payload.task ?? (payload.event ? "memory" : "chat"), held: hold });
      if (hold) await new Promise(() => {});
      const response = url.hostname === "assistant.example.invalid" ? { reply: "先记录真实输入，再核对输出与责任人。", recommendations: [], citations: [], memoryOperations: [{ operation: "noop", confidence: 100, reason: "没有新的长期事实" }] }
        : payload.task === "audit_micro_homomorphic_script" ? audit : { paragraphs: payload.source_paragraphs.map(row => ({ paragraph_id: row.paragraph_id, text: rewritten })) };
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    },
  });
  const origin = String(await mf.ready), db = await mf.getD1Database("DB");
  if (hold) {
    for (const file of readdirSync(path.join(root, "drizzle")).filter(name => name.endsWith(".sql")).sort()) for (const sql of splitSql(readFileSync(path.join(root, "drizzle", file), "utf8"))) await db.prepare(sql).run();
    const now = new Date().toISOString(), password = readFileSync(path.join(runDir, "synthetic-password.txt"), "utf8"), salt = randomBytes(16), hash = pbkdf2Sync(password, salt, 210000, 32, "sha256");
    await db.prepare("INSERT INTO users(id,auth_subject,email,display_name,status,created_at,updated_at) VALUES(?,?,?,'Restart fixture','active',?,?)").bind(userId, userId, "restart@example.invalid", now, now).run();
    await db.prepare("INSERT INTO local_credentials(user_id,password_salt,password_hash,iterations,created_at,updated_at) VALUES(?,?,?,210000,?,?)").bind(userId, salt.toString("base64url"), hash.toString("base64url"), now, now).run();
    await db.prepare("INSERT INTO organizations(id,name,slug,status,created_by,created_at,updated_at) VALUES(?,'Restart fixture','restart-fixture','active',?,?,?)").bind(scope.organizationId, userId, now, now).run();
    await db.prepare("INSERT INTO organization_members(id,organization_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('restart-member',?,?,'admin','active',?,?,?,?)").bind(scope.organizationId, userId, userId, userId, now, now).run();
    await db.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Restart fixture','Synthetic',?,?,?,?)").bind(scope.projectId, scope.organizationId, userId, userId, now, now).run();
    await db.prepare("INSERT INTO script_rewrite_workspaces(id,organization_id,project_id,title,source_type,source_label,source_text,source_hash,source_character_count,created_by,updated_by,created_at,updated_at) VALUES('restart-rewrite',?,?,'Synthetic','pasted','Synthetic',?,'synthetic',?,?,?,?,?)").bind(scope.organizationId, scope.projectId, source, source.length, userId, userId, now, now).run();
    await db.prepare("INSERT INTO script_rewrite_versions(id,organization_id,project_id,workspace_id,version,variant,text,created_by,created_at) VALUES('restart-source',?,?,'restart-rewrite',1,'source',?,?,?)").bind(scope.organizationId, scope.projectId, source, userId, now).run();
    await db.prepare("INSERT INTO project_memory_events(id,organization_id,project_id,event_type,source_type,source_id,dedupe_key,payload_hash,payload_json,status,created_by,created_at,updated_at) VALUES('restart-memory',?,?,'manual','manual','synthetic','synthetic','synthetic','{}','pending',?,?,?)").bind(scope.organizationId, scope.projectId, userId, now, now).run();
  }
  process.send({ event: "ready", origin });
  process.on("message", async message => { if (message === "stop") { await mf.dispose(); process.exit(0); } });
}

if (process.argv[2] === "--child") {
  await child(process.argv[3], process.argv[4] === "hold");
} else {
  assert.equal(process.platform, "win32", "This isolated process-tree acceptance targets Windows");
  const runDir = mkdtempSync(path.join(tmpdir(), "lz-rst-")), scenarios = [], providers = [], requests = [], startedAt = new Date().toISOString(), cpuStart = process.cpuUsage();
  let host, origin, cookie, sql;
  const password = randomBytes(18).toString("base64url"); writeFileSync(path.join(runDir, "synthetic-password.txt"), password);
  for (const folder of ["scripts", "resources/delivery"]) mkdirSync(path.join(runDir, folder), { recursive: true });
  for (const file of ["scripts/prepare-login-startup.mjs", "scripts/run-startup-guard.ps1", "scripts/analyzer-instance-lock.ps1", "resources/delivery/recover-startup-work.sql", "resources/delivery/revoke-startup-sessions.sql"]) copyFileSync(path.join(root, file), path.join(runDir, file));
  symlinkSync(path.join(root, "node_modules"), path.join(runDir, "node_modules"), "junction");
  writeFileSync(path.join(runDir, ".dev.vars"), "DELIVERY_MODE=0\nLOCAL_DEV_AUTH=0\nLAN_MODE=1\n");
  writeFileSync(path.join(runDir, "wrangler.local.jsonc"), JSON.stringify({ name: "restart-fixture", main: path.join(root, "worker/index.ts"), compatibility_date: "2026-08-05", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "restart-fixture", database_id: "00000000-0000-4000-8000-000000000000" }] }));
  const check = async (name, action) => { await action(); scenarios.push({ name, passed: true }); console.log(`PASS ${name}`); };
  const start = async hold => {
    host = fork(self, ["--child", runDir, hold ? "hold" : "respond"], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    host.stdout.on("data", chunk => writeFileSync(path.join(runDir, "host.log"), chunk, { flag: "a" })); host.stderr.on("data", chunk => writeFileSync(path.join(runDir, "host.log"), chunk, { flag: "a" }));
    origin = await deadline(new Promise((resolve, reject) => { host.on("message", message => { if (message.event === "ready") resolve(message.origin); if (message.event === "provider") providers.push(message); }); host.once("exit", code => reject(new Error(`Synthetic host exited before ready: ${code}`))); }));
  };
  const http = async (route, body, method = body ? "POST" : "GET") => {
    const start = performance.now();
    try {
    const response = await fetch(new URL(route, origin), { method, headers: { connection: "close", ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await response.json(); requests.push({ route, status: response.status, ms: Math.round(performance.now() - start) }); return { status: response.status, headers: response.headers, data };
    } catch (error) { requests.push({ route, status: null, error: error.name, ms: Math.round(performance.now() - start) }); throw error; }
  };
  const expect = (reply, status) => { assert.equal(reply.status, status, JSON.stringify(reply.data)); return reply.data; };
  const login = async () => { const result = await http("/api/auth/session", { email: "restart@example.invalid", password }); expect(result, 200); cookie = result.headers.get("set-cookie").split(";")[0]; };
  const terminate = async () => {
    const current = host; assert.ok(current?.pid && current.exitCode === null, "Expected a live isolated child handle");
    const exited = new Promise(resolve => current.once("exit", resolve));
    const killed = spawnSync("taskkill.exe", ["/PID", String(current.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 15000 }); assert.equal(killed.status, 0, killed.stderr);
    await deadline(exited); host = null;
  };
  const recover = () => { const result = spawnSync(process.execPath, ["scripts/prepare-login-startup.mjs"], { cwd: runDir, encoding: "utf8", windowsHide: true, timeout: 30000 }); writeFileSync(path.join(runDir, "startup.log"), result.stdout + result.stderr, { flag: "a" }); assert.equal(result.status, 0, result.stderr); };
  try {
    await start(true); await login(); const created = expect(await http("/api/project-assistant/conversations", scope), 201), conversationId = created.conversation.id;
    const attempts = [http("/api/script-rewrites/restart-rewrite/generate", { ...scope, variants: ["light_rewrite"] }), http("/api/project-memory/sync", { ...scope, limit: 1 }), http(`/api/project-assistant/conversations/${conversationId}/messages`, { ...scope, question: "请说明核对工作结果的方法" })].map(promise => promise.catch(error => ({ interrupted: true, reason: error.name })));
    await check("three live HTTP tasks reach locally held provider requests", async () => { await deadline(new Promise(resolve => { const timer = setInterval(() => { if (providers.length === 3) { clearInterval(timer); resolve(); } }, 20); timer.unref(); })); });
    await check("forced isolated process-tree exit interrupts all requests", async () => { await terminate(); const replies = await deadline(Promise.all(attempts)); assert.ok(replies.every(reply => reply.interrupted)); });
    await check("actual guarded startup and Wrangler recover the persisted database", async () => {
      recover(); const files = readdirSync(path.join(runDir, ".wrangler/state/v3/d1"), { recursive: true }).filter(file => /^[0-9a-f]{64}\.sqlite$/.test(path.basename(file)));
      assert.equal(files.length, 1); sql = new DatabaseSync(path.join(runDir, ".wrangler/state/v3/d1", files[0]), { readOnly: true });
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM model_calls WHERE status='failed' AND error_code='WEB_PROCESS_INTERRUPTED'").get().n, 3);
      assert.equal(sql.prepare("SELECT status FROM project_memory_events").get().status, "failed"); assert.equal(sql.prepare("SELECT status FROM script_rewrite_runs").get().status, "failed");
      assert.equal(sql.prepare("SELECT status FROM project_assistant_messages WHERE role='assistant'").get().status, "failed");
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").get().n, 1);
    });
    await start(false);
    await check("old session is refused and fresh password login reads retained source and failed run", async () => {
      expect(await http("/api/auth/session"), 401); await login();
      const detail = expect(await http(`/api/script-rewrites/restart-rewrite?organizationId=${scope.organizationId}&projectId=${scope.projectId}`), 200);
      assert.equal(detail.versions.length, 1); assert.equal(detail.versions[0].text, source); assert.equal(detail.runs[0].unknownRequestCount, 1);
    });
    await check("explicit rewrite retry, memory sync and new assistant turn succeed after restart", async () => {
      const oldRun = sql.prepare("SELECT id FROM script_rewrite_runs").get().id;
      expect(await http("/api/script-rewrites/restart-rewrite/generate", { ...scope, variants: ["light_rewrite"], retryOfRunId: oldRun }), 201);
      const memory = expect(await http("/api/project-memory/sync", { ...scope, limit: 1 }), 200); assert.equal(memory.results[0].status, "completed");
      expect(await http(`/api/project-assistant/conversations/${conversationId}/messages`, { ...scope, question: "请说明核对工作结果的方法" }), 201);
      assert.equal(sql.prepare("SELECT attempt_count FROM project_memory_events").get().attempt_count, 2);
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM model_calls").get().n, providers.length); assert.equal(providers.length, 7);
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM project_assistant_messages WHERE role='assistant' AND status='failed'").get().n, 1);
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM script_rewrite_versions").get().n, 2);
    });
    await check("repeated actual startup leaves finished receipts and drafts byte-identical", async () => {
      const before = JSON.stringify([sql.prepare("SELECT * FROM model_calls ORDER BY id").all(), sql.prepare("SELECT * FROM script_rewrite_versions ORDER BY id").all(), sql.prepare("SELECT * FROM script_rewrite_runs ORDER BY id").all()]);
      const stopped = new Promise(resolve => host.once("exit", resolve)); host.send("stop"); await deadline(stopped); host = null; recover();
      assert.equal(JSON.stringify([sql.prepare("SELECT * FROM model_calls ORDER BY id").all(), sql.prepare("SELECT * FROM script_rewrite_versions ORDER BY id").all(), sql.prepare("SELECT * FROM script_rewrite_runs ORDER BY id").all()]), before);
    });
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
  finally {
    if (host?.exitCode === null) await terminate(); sql?.close();
    const timings = requests.filter(request => request.status !== null).map(request => request.ms).sort((a, b) => a - b);
    const report = { passed: !process.exitCode && scenarios.length === 6, startedAt, finishedAt: new Date().toISOString(), scenarios, requests, providers,
      buildSha256: createHash("sha256").update(readFileSync(path.join(root, "dist/server/index.js"))).digest("hex"),
      metrics: { httpAttempts: requests.length, interruptedRequests: requests.filter(request => request.status === null).length,
        respondedP50Ms: timings[Math.floor(timings.length * .5)] ?? 0, respondedP95Ms: timings[Math.floor(timings.length * .95)] ?? 0, respondedMaxMs: timings.at(-1) ?? 0,
        parentHarnessRssBytes: process.memoryUsage().rss, parentHarnessCpuMicroseconds: process.cpuUsage(cpuStart), resourceBoundary: "Parent Node harness only; excludes child host, workerd and real supplier resources." },
      boundary: "Synthetic accounts/materials, local provider responses, forced Windows child process-tree exit; no real model spend, OS reboot or multi-device acceptance. Retained node_modules junction must never be recursively deleted.", runDir };
    writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, requests: requests.length, providerRequests: providers.length, evidence: path.join(runDir, "report.json") }));
  }
}
