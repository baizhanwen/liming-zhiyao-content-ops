import { splitSql } from "./sql-statements.mjs";
import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync, createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { spawn } from "node:child_process";

// Actual built Worker + HTTP + D1 + R2 + password sessions. Only the external
// media/model worker is simulated. Never loads .dev.vars or business storage.
const root = fileURLToPath(new URL("..", import.meta.url));
const runDir = path.join(root, ".local/stability-runs", new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex"));
mkdirSync(runDir, { recursive: true });
const serviceToken = randomBytes(32).toString("hex");
const password = randomBytes(18).toString("base64url");
const scenarios = [];
const requests = [];
const burstRounds = Number(process.env.LAN_TEST_ROUNDS || 10);
assert.ok(Number.isInteger(burstRounds) && burstRounds > 0 && burstRounds <= 100);
let mf, db, origin, currentScenario = "setup";
let d1Persist = path.join(runDir, "d1"), r2Persist = path.join(runDir, "r2");
const users = Array.from({ length: 11 }, (_, i) => ({
  id: `runtime-user-${i}`, email: `runtime-${i}@example.invalid`,
  org: i === 10 ? "org-other" : "org-team", project: i === 10 ? "project-other" : i % 2 ? "project-b" : "project-a",
}));

async function start() {
  const server = path.join(root, "dist/server");
  const config = JSON.parse(readFileSync(path.join(server, "wrangler.json"), "utf8"));
  const moduleNames = ["index.js", ...readdirSync(server, { recursive: true }).filter(p => p !== "index.js" && /\.m?js$/.test(p))];
  mf = new Miniflare({
    host: "127.0.0.1", port: 0,
    modules: moduleNames.map(p => ({ type: "ESModule", path: path.join(server, p) })), modulesRoot: server,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: "lan-runtime-fixture" }, d1Persist,
    r2Buckets: ["MEDIA", "MEDIA_LEGACY"], r2Persist,
    assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true } },
    // Reject any accidental external fetch from the application under test.
    outboundService: () => new Response("External access disabled in LAN runtime test", { status: 502 }),
    bindings: {
      DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0",
      ANALYZER_SERVICE_TOKEN: serviceToken, ANALYZER_LLM_API_KEY: "synthetic-runtime-fixture",
      ANALYZER_LLM_BASE_URL: "https://model.example.invalid", ANALYZER_LLM_MODEL: "runtime-fixture", ANALYZER_LLM_PROVIDER: "openai",
    },
  });
  origin = String(await mf.ready);
  db = await mf.getD1Database("DB");
}

async function seed() {
  for (const filename of readdirSync(path.join(root, "drizzle")).filter(p => p.endsWith(".sql")).sort()) {
    const statements = splitSql(readFileSync(path.join(root, "drizzle", filename), "utf8"));
    for (const sql of statements) await db.prepare(sql).run();
  }
  const now = new Date().toISOString();
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  await run("INSERT INTO installation_settings (key, value, updated_at) VALUES ('setup_completed', '1', ?)", now);
  for (const user of users) {
    await run("INSERT INTO users (id, auth_subject, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", user.id, user.id, user.email, user.id, now, now);
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, 210000, 32, "sha256");
    await run("INSERT INTO local_credentials (user_id, password_salt, password_hash, iterations, created_at, updated_at) VALUES (?, ?, ?, 210000, ?, ?)", user.id, salt.toString("base64url"), hash.toString("base64url"), now, now);
  }
  for (const org of ["org-team", "org-other"]) await run("INSERT INTO organizations (id, name, slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", org, org, org, users[0].id, now, now);
  for (const project of ["project-a", "project-b", "project-other"]) await run("INSERT INTO projects (id, organization_id, name, client_name, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'runtime fixture', 'active', ?, ?, ?, ?)", project, project === "project-other" ? "org-other" : "org-team", project, users[0].id, users[0].id, now, now);
  for (const user of users) {
    await run("INSERT INTO organization_members (id, organization_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?, ?, ?)", `om-${user.id}`, user.org, user.id, user.id, user.id, now, now);
    await run("INSERT INTO project_members (id, organization_id, project_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', 'active', ?, ?, ?, ?)", `pm-${user.id}`, user.org, user.project, user.id, user.id, user.id, now, now);
  }
}

async function http(route, { user, service = false, method = "GET", body, headers = {} } = {}) {
  const start = performance.now();
  // Match the Python urllib transport here. Browser tests separately exercise
  // normal persistent connections with ten independent cookie sessions.
  const requestHeaders = { connection: "close", ...headers };
  if (user?.cookie) requestHeaders.cookie = user.cookie;
  if (service) requestHeaders.authorization = `Bearer ${serviceToken}`;
  const encoded = body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body);
  if (body !== undefined && !(body instanceof FormData)) requestHeaders["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(new URL(route, origin), { method, headers: requestHeaders, body: encoded, signal: AbortSignal.timeout(15000), redirect: "manual" });
  } catch (error) {
    requests.push({ scenario: currentScenario, method, route, status: 0, transportError: error.cause?.code || error.name, ms: Math.round(performance.now() - start) });
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  let data; try { data = JSON.parse(bytes.toString()); } catch { data = null; }
  requests.push({ scenario: currentScenario, method, route, status: response.status, ms: Math.round(performance.now() - start) });
  return { status: response.status, data, bytes, headers: response.headers };
}
function expect(response, status) { assert.equal(response.status, status, JSON.stringify(response.data)); return response.data; }
async function scenario(name, action) {
  currentScenario = name;
  const start = performance.now();
  try { await action(); scenarios.push({ name, passed: true, ms: Math.round(performance.now() - start) }); console.log(`PASS ${name}`); }
  catch (error) { scenarios.push({ name, passed: false, error: error.message }); throw error; }
}
const scope = user => `organizationId=${user.org}&projectId=${user.project}`;
const browserAuth = () => ({ status: "logged_in", browser: "synthetic-fixture", checkedAt: new Date().toISOString() });
const claim = workerId => http("/api/internal/analysis-jobs/claim", { service: true, method: "POST", body: { workerId, leaseSeconds: 300, browserAuth: browserAuth() } });
let sequence = 1000;
const nextUrl = () => `https://www.douyin.com/video/123456789012345${sequence++}`;
const submit = (user, url = nextUrl()) => http("/api/videos/from-url", { user, method: "POST", body: { organizationId: user.org, projectId: user.project, url } });
const cancel = (user, jobId) => http(`/api/analysis-jobs/${jobId}/cancel`, { user, method: "POST" });
const retry = (user, jobId) => http(`/api/analysis-jobs/${jobId}/retry`, { user, method: "POST" });
const release = job => http(`/api/internal/analysis-jobs/${job.id}/release`, { service: true, method: "POST", body: { workerId: job.lease_owner, attempt: job.attempt_count } });
const heartbeat = (job, status = "analyzing", progress = 90) => http(`/api/internal/analysis-jobs/${job.id}/heartbeat`, { service: true, method: "POST", body: { workerId: job.lease_owner, version: job.version, status, progress, stage: "runtime fixture", leaseSeconds: 300, browserAuth: browserAuth() } });
const completion = job => ({ workerId: job.lease_owner, version: job.version, resultKey: `runtime-${job.id}-${job.version}`, analysis: { schemaVersion: "analysis.v7", confidence: 90, report: { fixture: true, analysis_meta: { quality_audit: { status: "passed", acceptance_passed: true, completion_status: "complete" } } }, modelProvider: "fixture", modelName: "fixture" }, transcript: { language: "zh", fullText: "隔离环境测试文本", segments: [], confidence: 90 } });
const complete = (job, body = completion(job)) => http(`/api/internal/analysis-jobs/${job.id}/complete`, { service: true, method: "POST", body });
async function analyzing(job) { const data = expect(await heartbeat(job), 200); return { ...job, ...data.job }; }
async function count(sql, ...args) { return (await db.prepare(sql).bind(...args).first()).n; }

let uploadFixture, persistentJob;
let browserResult = null, pythonResult = null;
try {
  console.log(`Evidence: ${runDir}`);
  await start();
  await seed();
  await scenario("真实账号登录与匿名/伪造身份拒绝", async () => {
    expect(await http("/api/health"), 200);
    expect(await http(`/api/videos?${scope(users[0])}`), 401);
    expect(await http(`/api/videos?${scope(users[0])}`, { headers: { "oai-authenticated-user-id": users[0].id, "oai-authenticated-user-email": users[0].email } }), 401);
    const logins = await Promise.all(users.map(user => http("/api/auth/session", { method: "POST", body: { email: user.email, password } })));
    logins.forEach((response, i) => { expect(response, 200); users[i].cookie = response.headers.get("set-cookie")?.split(";")[0]; assert.ok(users[i].cookie); });
    const sessions = await Promise.all(users.map(user => http("/api/auth/session", { user })));
    sessions.forEach(response => expect(response, 200));
  });
  await scenario("服务凭据与离线提交保护", async () => {
    expect(await http("/api/internal/analysis-jobs/claim", { method: "POST", body: { workerId: "unauthorized" } }), 401);
    const response = await submit(users[0]); expect(response, 503); assert.equal(response.data.error.code, "ANALYZER_OFFLINE");
    expect(await claim("runtime-initial"), 204);
  });
  await scenario("内容改稿、重新审核与发布版本绑定：真实 D1 并发写入", async () => {
    const { runContentLifecycleChecks } = await import("./content-lifecycle-checks.mjs");
    await runContentLifecycleChecks({ db, http, expect, users });
  });
  let batch;
  await scenario("10 个账号同时提交与跨项目/跨公司权限隔离", async () => {
    const responses = await Promise.all(users.slice(0, 10).map(user => submit(user)));
    batch = responses.map((response, i) => ({ ...expect(response, 202), user: users[i] }));
    assert.equal(new Set(batch.map(x => x.job.id)).size, 10);
    for (const user of users.slice(0, 10)) {
      const listing = expect(await http(`/api/videos?${scope(user)}`, { user }), 200);
      assert.deepEqual(new Set(listing.jobs.map(x => x.id)), new Set(batch.filter(x => x.user.project === user.project).map(x => x.job.id)));
      assert.equal(listing.queue.waitingCount, 10);
    }
    expect(await http(`/api/videos?${scope(users[1])}`, { user: users[0] }), 403);
    expect(await http(`/api/videos?${scope(users[10])}`, { user: users[0] }), 403);
    expect(await cancel(users[10], batch[0].job.id), 403);
    expect(await retry(users[10], batch[0].job.id), 403);
  });
  let claims;
  await scenario("20 个领取请求竞争 10 个任务，只授予 1 个主机执行名额", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`runtime-worker-${i}`)));
    responses.forEach(r => assert.ok([200, 204].includes(r.status), JSON.stringify(r.data)));
    claims = responses.filter(r => r.status === 200).map(r => r.data.job);
    assert.equal(claims.length, 1);
    assert.equal(responses.filter(r => r.status === 204).length, 19);
    assert.ok(batch.some(x => x.job.id === claims[0].id));
  });
  await scenario("结果并发提交与响应丢失后重发保持幂等", async () => {
    claims = await Promise.all(claims.map(analyzing));
    // The caller ignores the first reply and resends the exact same result.
    const first = claims[0], payload = completion(first);
    expect(await complete(first, payload), 200);
    assert.equal(expect(await complete(first, payload), 200).idempotent, true);
    for (let index = 1; index < 10; index++) {
      const job = await analyzing(expect(await claim(`runtime-drain-${index}`), 200).job);
      claims.push(job);
      const responses = await Promise.all([complete(job), complete(job)]);
      responses.forEach(r => assert.ok([200, 409].includes(r.status), JSON.stringify(r.data)));
    }
    assert.deepEqual(new Set(claims.map(j => j.id)), new Set(batch.map(x => x.job.id)));
    assert.equal(await count("SELECT COUNT(*) AS n FROM video_analyses"), 10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM video_transcripts"), 10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status = 'completed'"), 10);
  });
  await scenario("同链接并发提交只建一个任务", async () => {
    const url = nextUrl();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(users[(i % 5) * 2], url)));
    assert.equal(responses.filter(r => r.status === 202).length, 1);
    assert.equal(responses.filter(r => r.status === 409).length, 9);
    const created = responses.find(r => r.status === 202).data;
    expect(await cancel(users[0], created.job.id), 200);
  });
  await scenario("重复文件上传回滚与真实 R2 读取权限", async () => {
    const bytes = Buffer.from("isolated LAN opaque media fixture\n");
    const upload = () => { const form = new FormData(); form.set("file", new Blob([bytes], { type: "video/mp4" }), "fixture.mp4"); return http("/api/videos/upload", { user: users[0], method: "POST", body: form, headers: { "x-organization-id": users[0].org, "x-project-id": users[0].project } }); };
    const responses = await Promise.all(Array.from({ length: 5 }, upload));
    assert.equal(responses.filter(r => r.status === 202).length, 1);
    assert.equal(responses.filter(r => r.status === 409).length, 4);
    const created = responses.find(r => r.status === 202).data;
    const job = expect(await claim("runtime-upload"), 200).job; assert.equal(job.id, created.job.id);
    const route = `/api/internal/analysis-jobs/${job.id}/source`;
    const source = await http(route, { service: true, headers: { "x-worker-id": "runtime-upload" } }); expect(source, 200); assert.deepEqual(source.bytes, bytes);
    expect(await http(route, { service: true, headers: { "x-worker-id": "runtime-wrong" } }), 409);
    const objects = await (await mf.getR2Bucket("MEDIA")).list(); assert.equal(objects.objects.length, 1);
    uploadFixture = { key: objects.objects[0].key, videoId: created.video.id, hash: createHash("sha256").update(bytes).digest("hex") };
    expect(await cancel(users[0], job.id), 200);
    expect(await claim("must-wait-for-release"), 204);
    expect(await release(job), 200);
  });
  await scenario("取消与完成同时发生保持唯一终态", async () => {
    for (let i = 0; i < 10; i++) {
      const created = expect(await submit(users[0]), 202);
      const job = await analyzing(expect(await claim(`runtime-cancel-${i}`), 200).job);
      assert.equal(job.id, created.job.id);
      const responses = await Promise.all([cancel(users[0], job.id), complete(job)]);
      assert.equal(responses.filter(r => r.status === 200).length, 1);
      assert.equal(responses.filter(r => r.status === 409).length, 1);
      const state = await db.prepare("SELECT status FROM analysis_jobs WHERE id = ?").bind(job.id).first();
      assert.equal(await count("SELECT COUNT(*) AS n FROM video_analyses WHERE analysis_job_id = ?", job.id), state.status === "completed" ? 1 : 0);
      expect(await release(job), 200);
    }
  });
  await scenario("暂时失败后 10 次并发重试只恢复一次", async () => {
    expect(await submit(users[0]), 202);
    const job = expect(await claim("runtime-failure"), 200).job;
    expect(await http(`/api/internal/analysis-jobs/${job.id}/fail`, { service: true, method: "POST", body: { workerId: job.lease_owner, version: job.version, resultKey: `failure-${job.id}`, errorCode: "SOURCE_NETWORK_FAILED", errorMessage: "隔离测试注入下载超时", progress: 5, stage: "下载失败" } }), 200);
    const responses = await Promise.all(Array.from({ length: 10 }, () => retry(users[0], job.id)));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.equal(responses.filter(r => r.status === 409).length, 9);
    const resumed = expect(await claim("runtime-retry"), 200).job; assert.equal(resumed.id, job.id);
    expect(await complete(await analyzing(resumed)), 200);
  });
  await scenario("过期租约带检查点恢复并拒绝旧 Worker 写入", async () => {
    expect(await submit(users[0]), 202);
    const job = await analyzing(expect(await claim("runtime-expired"), 200).job);
    expect(await http(`/api/internal/analysis-jobs/${job.id}/checkpoint`, { service: true, method: "POST", body: { workerId: job.lease_owner, version: job.version, stage: "evidence_ready", checkpoint: { checkpoint_version: 1, fixture: "recover-me" } } }), 201);
    // Fault injection is confined to this test database; no wall-clock delay.
    await db.prepare("UPDATE analysis_jobs SET lease_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), job.id).run();
    const resumed = expect(await claim("runtime-recovered"), 200).job;
    assert.equal(resumed.id, job.id); assert.equal(resumed.progress, 82); assert.equal(resumed.checkpoint.fixture, "recover-me");
    expect(await heartbeat(job), 409); expect(await complete(job), 409);
    expect(await complete(await analyzing(resumed)), 200);
  });
  await scenario(`连续 ${burstRounds * 10} 次提交并伴随 ${burstRounds * 100} 次列表轮询`, async () => {
    for (let round = 0; round < burstRounds; round++) {
      expect(await claim(`runtime-burst-${round}`), 204);
      const submissions = users.slice(0, 10).map(user => submit(user));
      const reads = Array.from({ length: 10 }, async () => {
        for (const user of users.slice(0, 10)) expect(await http(`/api/videos?${scope(user)}`, { user }), 200);
      });
      const responses = await Promise.all(submissions);
      await Promise.all(reads);
      const created = responses.map((r, i) => ({ ...expect(r, 202), user: users[i] }));
      const claimed = [];
      for (let index = 0; index < 10; index++) {
        const job = expect(await claim(`runtime-burst-${round}-${index}`), 200).job;
        claimed.push(job.id);
        expect(await complete(await analyzing(job)), 200);
      }
      assert.deepEqual(new Set(claimed), new Set(created.map(x => x.job.id)));
      console.log(`  burst ${round + 1}/${burstRounds} finished`);
    }
  });
  await scenario("服务重启后任务/结果/登录会话/媒体文件仍可用", async () => {
    persistentJob = expect(await submit(users[0]), 202).job.id;
    const expectedAnalyses = await count("SELECT COUNT(*) AS n FROM video_analyses");
    await mf.dispose(); mf = null; await start();
    expect(await http(`/api/videos?${scope(users[0])}`, { user: users[0] }), 200);
    assert.equal(await count("SELECT COUNT(*) AS n FROM video_analyses"), expectedAnalyses);
    const object = await (await mf.getR2Bucket("MEDIA")).get(uploadFixture.key); assert.ok(object);
    assert.equal(createHash("sha256").update(Buffer.from(await object.arrayBuffer())).digest("hex"), uploadFixture.hash);
    const job = expect(await claim("runtime-after-restart"), 200).job; assert.equal(job.id, persistentJob);
    expect(await complete(await analyzing(job)), 200);
  });
  if (process.env.LAN_TEST_BACKUP === "1") await scenario("实际备份脚本恢复数据库与 R2：重新登录、版本关联、附件权限与继续审核发布", async () => {
    assert.equal(process.platform, "win32", "Shipped maintenance scripts require Windows");
    // Native Windows SQLite cannot use the long evidence-directory prefix.
    const installation = path.join(root, ".local/br", randomBytes(4).toString("hex"));
    const scripts = path.join(installation, "scripts"); mkdirSync(scripts, { recursive: true });
    for (const filename of ["backup-local.ps1", "restore-local.ps1", "local-state-maintenance.ps1", "analyzer-instance-lock.ps1"]) {
      cpSync(path.join(root, "scripts", filename), path.join(scripts, filename));
    }
    const tables = ["users", "local_credentials", "projects", "videos", "media_assets", "analysis_jobs", "video_analyses", "content_items", "content_versions", "content_reviews", "publication_records", "published_copy_records"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async name => {
      const rows = (await db.prepare(`SELECT * FROM ${name}`).all()).results.map(row => JSON.stringify(row)).sort();
      return [name, { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }];
    })));
    const before = await snapshot();
    const oldPort = new URL(origin).port;
    await mf.dispose(); mf = null;
    const state = path.join(installation, ".wrangler/state"); mkdirSync(state, { recursive: true });
    cpSync(d1Persist, path.join(state, "v3/d1"), { recursive: true }); cpSync(r2Persist, path.join(state, "v3/r2"), { recursive: true });
    d1Persist = path.join(state, "v3/d1"); r2Persist = path.join(state, "v3/r2");
    mkdirSync(path.join(installation, ".local")); writeFileSync(path.join(installation, ".local/app.port"), oldPort);
    const runMaintenance = async (name, input = "") => new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, name)], { cwd: installation, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
      const timer = setTimeout(() => {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        reject(new Error(`Maintenance timeout: ${name}`));
      }, 120000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => {
        clearTimeout(timer); writeFileSync(path.join(runDir, name + ".log"), output);
        if (code === 0) resolve(); else reject(new Error(`Maintenance failed (${code}): ${name}; see ${runDir}`));
      });
      child.stdin.on("error", () => {}); child.stdin.end(input);
    });
    await runMaintenance("backup-local.ps1");
    await start();
    await db.prepare("UPDATE projects SET name = 'changed-after-backup' WHERE id = ?").bind(users[0].project).run();
    await (await mf.getR2Bucket("MEDIA")).put(uploadFixture.key, "changed-after-backup");
    await mf.dispose(); mf = null;
    await runMaintenance("restore-local.ps1", "1\nRESTORE\n");
    await start();
    assert.deepEqual(await snapshot(), before, "All selected business table rows and links must return to the backup point");
    const login = await http("/api/auth/session", { method: "POST", body: { email: users[0].email, password } }); expect(login, 200);
    users[0].cookie = login.headers.get("set-cookie").split(";")[0];
    const mediaRoute = `/api/videos/${uploadFixture.videoId}/media?${scope(users[0])}`;
    const media = await http(mediaRoute, { user: users[0] }); expect(media, 200);
    assert.equal(createHash("sha256").update(media.bytes).digest("hex"), uploadFixture.hash);
    expect(await http(mediaRoute, { user: users[10] }), 403);
    // Run the complete write/review/publish lifecycle against the restored database.
    const { runContentLifecycleChecks } = await import("./content-lifecycle-checks.mjs");
    await runContentLifecycleChecks({ db, http, expect, users, fixtureSuffix: "-restored" });
    writeFileSync(path.join(runDir, "backup-recovery.json"), JSON.stringify({ passed: true, synthetic: true, installation, tables: before, login: true, mediaSha256: uploadFixture.hash, mediaUnauthorizedStatus: 403, lifecycleAfterRestore: true, config: "No business configuration or API keys loaded; private configuration recovery requires separate administrator steps." }, null, 2));
  });
  if (process.env.LAN_TEST_PYTHON) await scenario("5 人各 10 条：隔离处理进程经历卡死、崩溃、取消、断网和丢失响应后完成队列", async () => {
    const submissions = await Promise.all(users.slice(0, 5).flatMap(user => Array.from({ length: 10 }, () => submit(user))));
    const jobs = submissions.map(response => expect(response, 202).job.id);
    assert.equal(new Set(jobs).size, 50);
    assert.equal(expect(await submit(users[0]), 429).error.code, "ANALYSIS_USER_QUEUE_FULL");
    assert.equal(expect(await submit(users[5]), 429).error.code, "ANALYSIS_HOST_QUEUE_FULL");
    pythonResult = await new Promise((resolve, reject) => {
      const child = spawn(process.env.LAN_TEST_PYTHON, [path.join(root, "scripts/lan-worker-check.py")], {
        cwd: root, windowsHide: true,
        env: { ...process.env, PYTHONPATH: path.join(root, "services/analyzer"), PYTHONIOENCODING: "utf-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", errors = "";
      child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Python runtime test exceeded 120 seconds")); }, 120000);
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", code => { clearTimeout(timeout); if (code !== 0) reject(new Error(errors)); else { try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid Python fixture output")); } } });
      child.stdin.end(JSON.stringify({ origin, token: serviceToken, jobIds: jobs, cancelCookie: users[0].cookie, workspace: runDir }));
    });
    requests.push(...pythonResult.requests);
    assert.deepEqual(new Set(pythonResult.processed), new Set(jobs));
    for (const id of jobs) {
      const state = await db.prepare("SELECT status, error_code FROM analysis_jobs WHERE id = ?").bind(id).first();
      const expectedFailure = pythonResult.failures[id];
      assert.equal(state.status, id === jobs[4] ? "cancelled" : expectedFailure ? "failed" : "completed");
      if (expectedFailure) assert.equal(state.error_code, expectedFailure);
      assert.equal(await count("SELECT COUNT(*) AS n FROM video_analyses WHERE analysis_job_id = ?", id), expectedFailure || id === jobs[4] ? 0 : 1);
    }
    delete pythonResult.requests;
  });
  if (process.env.LAN_TEST_PLAYWRIGHT_MODULE) await scenario("10 个真实浏览器登录/提交/刷新/取消与登录断网恢复", async () => {
    expect(await claim("runtime-browser"), 204);
    const browserScopeTime = new Date().toISOString();
    await db.prepare("INSERT INTO project_members (id, organization_id, project_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES ('browser-extra-project', 'org-team', 'project-b', ?, 'member', 'active', ?, ?, ?, ?)")
      .bind(users[0].id, users[0].id, users[0].id, browserScopeTime, browserScopeTime).run();
    const { runBrowserChecks } = await import("./lan-browser-checks.mjs");
    browserResult = await runBrowserChecks({ origin, users, password, runDir, nextUrl, requests });
  });
  await scenario("退出登录后旧 Cookie 无法继续访问", async () => {
    expect(await http("/api/auth/session", { user: users[0], method: "DELETE" }), 200);
    expect(await http(`/api/videos?${scope(users[0])}`, { user: users[0] }), 401);
  });
} catch (error) {
  console.error(error.stack);
  console.dir(error, { depth: 5 });
  if (!scenarios.some(s => !s.passed)) scenarios.push({ name: currentScenario, passed: false, error: error.message });
  process.exitCode = 1;
} finally {
  if (mf) await mf.dispose();
  const timings = requests.map(r => r.ms).sort((a, b) => a - b);
  const report = {
    at: new Date().toISOString(), passed: scenarios.every(s => s.passed), browser: browserResult ?? "未运行（设置 LAN_TEST_PLAYWRIGHT_MODULE 可启用）", pythonWorker: pythonResult ?? "未运行（设置 LAN_TEST_PYTHON 可启用）",
    boundary: "真实编译 Worker、HTTP、D1、R2、密码登录；同机 10 客户端，Node 请求使用短连接，浏览器场景使用正常连接；外部下载/转写/模型使用测试替身，未验证真实局域网链路、视频处理速度或抖音成功率。",
    buildSha256: createHash("sha256").update(readFileSync(path.join(root, "dist/server/index.js"))).digest("hex"),
    scenarios, metrics: { requests: requests.length, http5xx: requests.filter(r => r.status >= 500).length, p50Ms: timings[Math.floor(timings.length * .5)] ?? 0, p95Ms: timings[Math.floor(timings.length * .95)] ?? 0, maxMs: timings.at(-1) ?? 0 }, requests,
  };
  writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(runDir, "report.md"), `# 局域网运行时测试\n\n时间：${report.at}\n\n结果：${report.passed ? "通过" : "失败"}\n\n${report.boundary}\n\n请求数：${report.metrics.requests}，P95：${report.metrics.p95Ms} ms，最大：${report.metrics.maxMs} ms。\n\n5xx 包括主动注入的分析服务离线 503；逐条请求在 report.json。\n\n| 场景 | 结果 |\n|---|---|\n${scenarios.map(s => `| ${s.name} | ${s.passed ? "通过" : `失败：${s.error.replaceAll("\n", " ").replaceAll("|", "/")}`} |`).join("\n")}\n`);
  console.log(JSON.stringify({ passed: report.passed, ...report.metrics, report: path.join(runDir, "report.md") }));
}
