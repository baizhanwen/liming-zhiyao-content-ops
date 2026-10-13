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
let syntheticModelMode=false, syntheticModelRequests=0;
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
    outboundService: request => {
      if (syntheticModelMode && new URL(request.url).hostname === "model.example.invalid") {
        syntheticModelRequests++;
        return Response.json({usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20},choices:[{message:{content:""}}]});
      }
      return new Response("External access disabled in LAN runtime test",{status:502});
    },
    bindings: {
      DELIVERY_MODE: "1", LOCAL_DEV_AUTH: "0", TRUST_FORWARDED_IDENTITY: "0",
      ...(process.env.LAN_TEST_DEV_AUTH === "1" ? { DELIVERY_MODE: "0", LOCAL_DEV_AUTH: "1", TRUST_FORWARDED_IDENTITY: "1", LAN_MODE: "1", LAN_ACCESS_ORIGIN: "http://192.168.50.10:3000" } : {}),
      ANALYZER_SERVICE_TOKEN: serviceToken, ANALYZER_LLM_API_KEY: "synthetic-runtime-fixture",
      ANALYZER_LLM_BASE_URL: "https://model.example.invalid", ANALYZER_LLM_MODEL: "runtime-fixture", ANALYZER_LLM_PROVIDER: "openai",
      PROJECT_ASSISTANT_MODEL_API_KEY:"synthetic-runtime-fixture",PROJECT_ASSISTANT_MODEL_BASE_URL:"https://model.example.invalid",PROJECT_ASSISTANT_MODEL_NAME:"runtime-fixture",PROJECT_ASSISTANT_MODEL_PROVIDER:"openai",
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
  await scenario("素材迁移包部分失败、重放与附件读取：真实HTTP/D1/R2", async () => {
    const user = users[1], source = users[0];
    const rows = (await db.prepare(`SELECT library.id,v.id AS video_id FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id
      WHERE v.organization_id=? AND v.project_id=? AND v.deleted_at IS NULL AND (v.id=? OR EXISTS(SELECT 1 FROM video_analyses analysis WHERE analysis.video_id=v.id)) ORDER BY (v.id=?) DESC LIMIT 2`)
      .bind(source.org,source.project,uploadFixture.videoId,uploadFixture.videoId).all()).results;
    assert.equal(rows.length,2);
    const manifest = expect(await http(`/api/video-library/transfer?organizationId=${user.org}&entryIds=${rows.map(r=>r.id).join(',')}`,{user}),200);
    manifest.entries.sort((a,b)=>b.assets.length-a.assets.length); assert.equal(manifest.entries[0].assets.length,1);
    const files = new Map();
    for (const entry of manifest.entries) for (const asset of entry.assets) { const response=await http(asset.downloadUrl,{user}); expect(response,200); files.set(asset.blobName,response.bytes); }
    const first=manifest.entries[0], originalAsset=first.assets[0];
    first.video.durationSec=null; first.library.notes="\n  preserved note  \n"; first.library.tags=["  preserved tag  "];
    first.transcripts=[{version:1,language:"zh-CN",source:"asr",full_text:"\n  preserved text\u0000tail  \n",segments_json:"[]",confidence:null,created_at:"2020-01-01T00:00:00.000Z",updated_at:"2020-02-01T00:00:00.000Z"}];
    first.metrics=[{source:"manual",plays:null,likes:0,collected_at:"2024-01-02T00:00:00.000Z",created_at:"2024-01-03T00:00:00.000Z"}];
    first.analyses=[1,2].map(index=>({schema_version:"analysis.v1",report_json:JSON.stringify({sentinel:index}),confidence:null,created_at:index===1?"2020-01-01T00:00:00.000Z":"2024-01-01T00:00:00.000Z",updated_at:"2024-01-01T00:00:00.000Z"}));
    first.assets.push({...originalAsset,id:"synthetic-frame",blobName:"synthetic-frame",kind:"keyframe",filename:"frame.jpg",contentType:"image/jpeg",isCover:1,qualityScore:0.9}); files.set("synthetic-frame",files.get(originalAsset.blobName));
    manifest.entries[1].video.title="Synthetic transfer HTTP failing item";
    const submitPackage = () => {
      const form = new FormData(); form.set("organizationId",user.org); form.set("projectId",user.project); form.set("manifest",JSON.stringify(manifest));
      for (const [name,bytes] of files) form.append("media",new Blob([bytes]),name);
      return http("/api/video-library/transfer",{user,method:"POST",body:form});
    };
    const beforeVideos = await count("SELECT COUNT(*) AS n FROM videos WHERE organization_id=? AND project_id=?",user.org,user.project);
    await db.exec("CREATE TRIGGER synthetic_material_http_failure BEFORE INSERT ON videos WHEN NEW.title='Synthetic transfer HTTP failing item' BEGIN SELECT RAISE(ABORT,'synthetic material item failure'); END");
    let partial;
    try { partial=await submitPackage(); expect(partial,500); assert.deepEqual(partial.data.progress,{imported:1,skipped:0,failedEntry:2,remaining:1}); }
    finally { await db.exec("DROP TRIGGER synthetic_material_http_failure"); }
    assert.equal(await count("SELECT COUNT(*) AS n FROM videos WHERE organization_id=? AND project_id=?",user.org,user.project),beforeVideos+1);
    const replay=expect(await submitPackage(),200); assert.deepEqual(replay,{imported:1,skipped:1});
    assert.equal(await count("SELECT COUNT(*) AS n FROM videos WHERE organization_id=? AND project_id=?",user.org,user.project),beforeVideos+2);
    const imported=await db.prepare("SELECT id FROM videos WHERE organization_id=? AND project_id=? AND source_hash=?").bind(user.org,user.project,manifest.entries[0].video.sourceHash).first();
    const videoState=await db.prepare("SELECT duration_sec FROM videos WHERE id=?").bind(imported.id).first(); assert.equal(videoState.duration_sec,null);
    const transcriptState=await db.prepare("SELECT full_text,confidence,created_at FROM video_transcripts WHERE video_id=?").bind(imported.id).first(); assert.equal(transcriptState.full_text,first.transcripts[0].full_text); assert.equal(transcriptState.confidence,null); assert.equal(transcriptState.created_at,first.transcripts[0].created_at);
    const metricState=await db.prepare("SELECT plays,likes,created_at FROM video_metric_snapshots WHERE video_id=?").bind(imported.id).first(); assert.equal(metricState.plays,null); assert.equal(metricState.likes,0); assert.equal(metricState.created_at,first.metrics[0].created_at);
    const latest=await db.prepare("SELECT created_at,report_json FROM video_analyses WHERE video_id=? ORDER BY created_at DESC LIMIT 1").bind(imported.id).first(); assert.equal(latest.created_at,"2024-01-01T00:00:00.000Z"); assert.equal(JSON.parse(latest.report_json).sentinel,2);
    const cover=await db.prepare("SELECT is_cover,quality_score FROM media_assets WHERE video_id=? AND kind='keyframe'").bind(imported.id).first(); assert.equal(cover.is_cover,1); assert.equal(cover.quality_score,0.9);
    const media=await http(`/api/videos/${imported.id}/media?${scope(user)}`,{user}); expect(media,200);
    assert.equal(createHash("sha256").update(media.bytes).digest("hex"),uploadFixture.hash);
    expect(await http(`/api/videos/${imported.id}/media?${scope(user)}`,{user:users[10]}),403);
    const job=await db.prepare("SELECT status,idempotency_key FROM analysis_jobs WHERE video_id=?").bind(imported.id).first(); assert.equal(job.status,"completed"); assert.ok(job.idempotency_key.startsWith("material-import:"));
    expect(await http("/api/video-library/transfer",{user,method:"POST",body:{malformed:true}}),400);
    writeFileSync(path.join(runDir,"material-transfer.json"),JSON.stringify({passed:true,synthetic:true,partial:partial.data.progress,replay,exactTranscript:true,unknownConfidence:null,newestAnalysis:2,coverPreserved:true,mediaSha256:uploadFixture.hash,unauthorizedStatus:403,boundary:"Actual compiled HTTP/D1/R2; synthetic report and opaque bytes, no codecs, external models or business accounts"},null,2));
  });
  await scenario("素材导入、移出、审计回退与旧页面冲突：真实HTTP/D1", async () => {
    const user = users[0], library = await db.prepare(`SELECT library.id,library.updated_at,v.id AS video_id,analysis.id AS analysis_id
      FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id AND v.deleted_at IS NULL
      JOIN video_analyses analysis ON analysis.id=(SELECT latest.id FROM video_analyses latest WHERE latest.video_id=v.id AND latest.organization_id=v.organization_id ORDER BY latest.created_at DESC LIMIT 1)
      WHERE library.organization_id=? AND NOT EXISTS(SELECT 1 FROM project_video_references refs WHERE refs.library_entry_id=library.id AND refs.project_id=? AND refs.purpose='benchmark') LIMIT 1`).bind(user.org, user.project).first();
    assert.ok(library, "Need an analyzed synthetic fixture without the target benchmark reference");
    const body = { organizationId: user.org, projectId: user.project, entryIds: [library.id] };
    const imports = await Promise.all([1, 2].map(() => http("/api/video-library/references", { user, method: "POST", body })));
    assert.ok(imports.every(r => [201,409].includes(r.status))); assert.ok(imports.some(r => r.status === 201));
    const refs = (await db.prepare("SELECT * FROM project_video_references WHERE library_entry_id=? AND project_id=? AND purpose='benchmark'").bind(library.id,user.project).all()).results;
    assert.equal(refs.length, 1); assert.equal(refs[0].status, "active");
    const reference = refs[0], memory = (await db.prepare("SELECT * FROM project_memory_events WHERE organization_id=? AND project_id=? AND source_id=? AND json_extract(payload_json,'$.benchmarkReferenceId')=?").bind(user.org,user.project,library.analysis_id,reference.id).all()).results;
    assert.equal(memory.length,1);
    const metadata = { organizationId: user.org, entryId: library.id, expectedUpdatedAt: library.updated_at, category: "case", tags: ["synthetic-shared-edit"], notes: null };
    const edits = await Promise.all([1,2].map(() => http("/api/video-library", { user, method: "PATCH", body: metadata })));
    assert.deepEqual(edits.map(r => r.status).sort(), [200,409]);
    assert.equal(edits.find(r => r.status === 409).data.error.code, "LIBRARY_VERSION_CONFLICT");
    expect(await http("/api/video-library/references", { user: users[10], method: "POST", body }), 403);
    const missing = await http("/api/video-library/references", { user, method: "POST", body: { ...body, entryIds: [library.id,"synthetic-missing-entry"] } }); expect(missing,404);
    const removal = { organizationId: user.org, projectId: user.project, referenceId: reference.id };
    await db.exec("CREATE TRIGGER synthetic_library_remove_failure BEFORE INSERT ON audit_logs WHEN NEW.action='video_library.removed' BEGIN SELECT RAISE(ABORT,'synthetic removal failure'); END");
    try {
      expect(await http("/api/video-library/references", { user, method: "DELETE", body: removal }),500);
      assert.equal((await db.prepare("SELECT status FROM project_video_references WHERE id=?").bind(reference.id).first()).status,"active");
    } finally { await db.exec("DROP TRIGGER synthetic_library_remove_failure"); }
    expect(await http("/api/video-library/references", { user, method: "DELETE", body: removal }),200);
    assert.ok(await db.prepare("SELECT id FROM videos WHERE id=? AND deleted_at IS NULL").bind(library.video_id).first());
    const replay = expect(await http("/api/video-library/references", { user, method: "POST", body }),201);
    assert.equal(replay.actions[0].id,reference.id); assert.equal(replay.actions[0].action,"reactivated");
    assert.equal(await count("SELECT COUNT(*) AS n FROM project_memory_events WHERE organization_id=? AND project_id=? AND source_id=? AND json_extract(payload_json,'$.benchmarkReferenceId')=?",user.org,user.project,library.analysis_id,reference.id),1);
    writeFileSync(path.join(runDir,"library-write.json"),JSON.stringify({ passed:true, synthetic:true, importStatuses:imports.map(r=>r.status), editStatuses:edits.map(r=>r.status), referenceId:reference.id, memoryEvents:1, intentionalAuditFailureStatus:500, boundary:"Actual compiled HTTP and D1; synthetic identities and reports, no real business or model calls" },null,2));
  });
  await scenario("100条素材导出与失效选择拒绝：真实HTTP/D1", async () => {
    const user=users[0], ids=[], now=new Date().toISOString(), statements=[];
    for(let index=0;index<100;index++) {
      const video=crypto.randomUUID(), entry=crypto.randomUUID(); ids.push(entry);
      statements.push(db.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_hash,source_url,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,?,'ready',?,?,?,?)").bind(video,user.org,user.project,`synthetic-100-${index}`,`https://example.invalid/export-${index}`,user.id,user.id,now,now));
      statements.push(db.prepare("INSERT INTO video_library_entries(id,organization_id,source_video_id,category,tags_json,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'other','[]',?,?,?,?)").bind(entry,user.org,video,user.id,user.id,now,now));
    }
    await db.batch(statements);
    const exportIds=async values=>http(`/api/video-library/transfer?organizationId=${user.org}&entryIds=${values.join(',')}`,{user});
    const manifest=expect(await exportIds(ids),200); assert.equal(manifest.entries.length,100);
    const over=await exportIds([...ids,crypto.randomUUID()]);expect(over,400);
    const missing=await exportIds([ids[0],crypto.randomUUID()]);expect(missing,409);
    const overAll=await http(`/api/video-library/transfer?organizationId=${user.org}`,{user});expect(overAll,400);
    writeFileSync(path.join(runDir,"material-export-selection.json"),JSON.stringify({passed:true,synthetic:true,exported:100,oversizedStatus:400,missingStatus:409,allOverLimitStatus:400,boundary:"Actual compiled Worker and D1; directly seeded synthetic rows, no model or field data"},null,2));
  });
  await scenario("无报告与部分报告迁移、只读和主动分析额度：真实HTTP/D1/R2", async () => {
    const user=users[1], states=["missing","partial","passed"], form=new FormData();
    const entries=states.map((state,index)=>({library:{category:"other",tags:[],notes:null},video:{platform:"upload",sourceType:"upload",sourceHash:`synthetic-readiness-${index}`,title:`Synthetic readiness ${state}`,sourceMediaBlobName:`ready-${index}`},assets:[{blobName:`ready-${index}`,kind:"source_video",filename:`ready-${index}.mp4`,contentType:"video/mp4"}],transcripts:[],analyses:state==="missing"?[]:[{schema_version:"analysis.v7",report_json:JSON.stringify({analysis_meta:{quality_audit:{status:state==="passed"?"passed":"degraded",acceptance_passed:state==="passed",completion_status:state==="passed"?"complete":"partial",issues:state==="passed"?[]:["缺少视觉证据"]}}}),created_at:"2024-01-01T00:00:00.000Z"}],metrics:[]}));
    form.set("organizationId",user.org);form.set("projectId",user.project);form.set("manifest",JSON.stringify({format:"liming-video-library-package",version:1,entries}));
    entries.forEach((entry,index)=>form.append("media",new Blob([`synthetic-ready-${index}`]),entry.assets[0].blobName));
    const beforeModels=await count("SELECT COUNT(*) AS n FROM analysis_model_calls")+await count("SELECT COUNT(*) AS n FROM model_calls");
    const imported=expect(await http("/api/video-library/transfer",{user,method:"POST",body:form}),200);assert.equal(imported.imported,3);
    const videos=(await db.prepare("SELECT * FROM videos WHERE organization_id=? AND project_id=? AND source_hash LIKE 'synthetic-readiness-%'").bind(user.org,user.project).all()).results;
    const missing=videos.find(v=>v.title.endsWith("missing")),partial=videos.find(v=>v.title.endsWith("partial")),passed=videos.find(v=>v.title.endsWith("passed"));
    assert.equal(missing.status,"pending");assert.equal(await count("SELECT COUNT(*) AS n FROM analysis_jobs WHERE video_id=?",missing.id),0);
    const partialJob=await db.prepare("SELECT * FROM analysis_jobs WHERE video_id=?").bind(partial.id).first();assert.equal(partialJob.status,"partial");
    assert.equal((await db.prepare("SELECT status FROM analysis_jobs WHERE video_id=?").bind(passed.id).first()).status,"completed");
    const retryImport=await http(`/api/analysis-jobs/${partialJob.id}/retry`,{user,method:"POST",body:{}});expect(retryImport,409);assert.equal(retryImport.data.error.code,"IMPORTED_REPORT_REANALYSIS_REQUIRED");
    const library=expect(await http(`/api/video-library?organizationId=${user.org}&q=Synthetic%20readiness`,{user}),200);assert.equal(library.entries.length,3);
    const missingEntry=library.entries.find(e=>e.video_id===missing.id);assert.equal(missingEntry.analysis_id,null);assert.equal(missingEntry.job_status,null);
    assert.equal(library.entries.find(e=>e.video_id===partial.id).analysis_acceptance_passed,0);
    const owned=expect(await http(`/api/videos?${scope(user)}`,{user}),200);assert.equal(owned.videos.find(v=>v.id===missing.id).analysis_id,null);assert.equal(owned.jobs.find(j=>j.id===partialJob.id).is_imported_job,1);
    const detail=expect(await http(`/api/videos/${missing.id}?${scope(user)}`,{user}),200);assert.equal(detail.analysis,null);assert.equal(detail.job,null);assert.equal(detail.canWrite,true);
    const shared=expect(await http(`/api/videos/${missing.id}?organizationId=${user.org}&projectId=${users[0].project}&libraryEntryId=${missingEntry.id}`,{user:users[0]}),200);assert.equal(shared.canWrite,false);
    const reanalyze=caller=>http(`/api/videos/${missing.id}/reanalyze`,{user:caller,method:"POST",body:{organizationId:user.org,projectId:user.project}});
    expect(await reanalyze(users[0]),403);
    const original=(await db.prepare("SELECT monthly_analysis_quota FROM organization_settings WHERE organization_id=?").bind(user.org).first()).monthly_analysis_quota;
    const usage=await count("SELECT COUNT(*) AS n FROM analysis_jobs WHERE organization_id=? AND created_at>=strftime('%Y-%m-01T00:00:00.000Z','now') AND created_at<strftime('%Y-%m-%dT00:00:00.000Z','now','start of month','+1 month') AND idempotency_key NOT LIKE 'material-import:%'",user.org);
    try {await db.prepare("UPDATE organization_settings SET monthly_analysis_quota=? WHERE organization_id=?").bind(usage,user.org).run();expect(await reanalyze(user),429);assert.equal(await count("SELECT COUNT(*) AS n FROM analysis_jobs WHERE video_id=?",missing.id),0);}
    finally {await db.prepare("UPDATE organization_settings SET monthly_analysis_quota=? WHERE organization_id=?").bind(original,user.org).run();}
    const accepted=expect(await reanalyze(user),201);const job=await db.prepare("SELECT idempotency_key,source_ref FROM analysis_jobs WHERE id=?").bind(accepted.job.id).first();assert.ok(job.idempotency_key.startsWith("reanalyze:"));assert.ok(job.source_ref);
    expect(await cancel(user,accepted.job.id),200);
    assert.equal(await count("SELECT COUNT(*) AS n FROM analysis_model_calls")+await count("SELECT COUNT(*) AS n FROM model_calls"),beforeModels);
    writeFileSync(path.join(runDir,"material-analysis-readiness.json"),JSON.stringify({passed:true,synthetic:true,imported:3,unanalysedJobsBeforeAction:0,partialPreserved:true,retryImportStatus:409,sharedCanWrite:false,foreignActorStatus:403,quotaDeniedStatus:429,explicitAnalysisStatus:201,recordedModelCalls:0,boundary:"Actual local HTTP/D1/R2; opaque synthetic files and report metadata, no real processor or model invocation"},null,2));
  });
  await scenario("material export media budget and record preflight: actual HTTP/D1",async()=>{
    const user=users[0],row=await db.prepare("SELECT library.id AS entry_id, v.media_asset_id AS asset_id, a.size_bytes FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id JOIN media_assets a ON a.id=v.media_asset_id WHERE v.id=? AND v.organization_id=?").bind(uploadFixture.videoId,user.org).first();assert.ok(row);
    const route=`/api/video-library/transfer?organizationId=${user.org}&entryIds=${row.entry_id}`,temporary=[];
    try {
      await db.prepare("UPDATE media_assets SET size_bytes=? WHERE id=?").bind(750*1024*1024+1,row.asset_id).run();
      const over=await http(route,{user});expect(over,413);assert.equal(over.data.error.code,"MATERIAL_PACKAGE_TOO_LARGE");
      await db.prepare("UPDATE media_assets SET size_bytes=? WHERE id=?").bind(750*1024*1024,row.asset_id).run();expect(await http(route,{user}),200);
      await db.prepare("UPDATE media_assets SET size_bytes=? WHERE id=?").bind(row.size_bytes,row.asset_id).run();
      for(let i=0;i<21;i++){
        const id=crypto.randomUUID();temporary.push(id);await db.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES(?,?,?,?, 'analysis.v1','{}',?,?,?)").bind(id,user.org,user.project,uploadFixture.videoId,user.id,new Date().toISOString(),new Date().toISOString()).run();
      }
      const records=await http(route,{user});expect(records,400);assert.equal(records.data.error.code,"MATERIAL_RECORD_LIMIT");
    }finally{
      await db.prepare("UPDATE media_assets SET size_bytes=? WHERE id=?").bind(row.size_bytes,row.asset_id).run();
      if(temporary.length)await db.prepare("DELETE FROM video_analyses WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(temporary)).run();
    }
    expect(await http(route,{user}),200);
    writeFileSync(path.join(runDir,"material-export-budget.json"),JSON.stringify({passed:true,synthetic:true,oversizeStatus:413,exactBoundaryStatus:200,recordsStatus:400,restoredStatus:200,mediaAllocation:false,boundary:"Actual compiled HTTP/D1, synthetic size metadata; no 750 MiB media allocation, real codec or field capacity measurement"},null,2));
  });

  await scenario("escaped material manifest budget: actual HTTP/D1",async()=>{
    const user=users[0],row=await db.prepare("SELECT id FROM video_library_entries WHERE organization_id=? AND source_video_id=?").bind(user.org,uploadFixture.videoId).first();assert.ok(row);
    const route=`/api/video-library/transfer?organizationId=${user.org}&entryIds=${row.id}`,temporary=[];
    try {
      for(let i=0;i<8;i++){
        const id=crypto.randomUUID();temporary.push(id);
        await db.prepare(`INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at)
          VALUES(?,?,?,?,'analysis.v1','{"payload":"' || replace(hex(zeroblob(650000)),'00',char(92)||char(92)) || '"}',?,?,?)`)
          .bind(id,user.org,user.project,uploadFixture.videoId,user.id,new Date().toISOString(),new Date().toISOString()).run();
      }
      const response=await http(route,{user});expect(response,413);assert.equal(response.data.error.code,"MATERIAL_MANIFEST_TOO_LARGE");
    }finally{if(temporary.length)await db.prepare("DELETE FROM video_analyses WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(temporary)).run();}
    expect(await http(route,{user}),200);
    writeFileSync(path.join(runDir,"material-json-budget.json"),JSON.stringify({passed:true,synthetic:true,escapedOverBudgetStatus:413,restoredStatus:200,records:8,recordedModelCalls:0,boundary:"Actual compiled Worker/HTTP/D1 with synthetic escape-heavy report strings; no real business or host-capacity proof"},null,2));
  });

  await scenario("knowledge import atomic rollback, duplicate competition and Unicode: actual HTTP/D1",async()=>{
    const user=users[0],title="ΑΒΓ合成知识",body={organizationId:user.org,projectId:user.project,filename:"synthetic-knowledge.xlsx",rows:[{"标题":title,"分类":"其他","知识正文":"这是一段隔离测试使用的合成品牌知识。","来源类型":"人工录入"}]};
    const beforeItems=await count("SELECT COUNT(*) AS n FROM knowledge_items"),beforeVersions=await count("SELECT COUNT(*) AS n FROM knowledge_item_versions"),beforeAudits=await count("SELECT COUNT(*) AS n FROM audit_logs");
    await db.prepare("CREATE TRIGGER synthetic_knowledge_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='knowledge.imported' BEGIN SELECT RAISE(ABORT,'synthetic knowledge audit failure'); END").run();
    try{expect(await http("/api/knowledge/import",{user,method:"POST",body}),500);assert.equal(await count("SELECT COUNT(*) AS n FROM knowledge_items"),beforeItems);assert.equal(await count("SELECT COUNT(*) AS n FROM knowledge_item_versions"),beforeVersions);assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs"),beforeAudits);}finally{await db.prepare("DROP TRIGGER synthetic_knowledge_audit_failure").run();}
    const competition=await Promise.all([http("/api/knowledge/import",{user,method:"POST",body}),http("/api/knowledge/import",{user,method:"POST",body})]);assert.deepEqual(competition.map(r=>r.status).sort(),[201,409]);
    expect(await http("/api/knowledge/import",{user,method:"POST",body}),409);
    assert.equal(await count("SELECT COUNT(*) AS n FROM knowledge_items WHERE organization_id=? AND project_id=? AND title=?",user.org,user.project,title),1);
    expect(await http("/api/knowledge/import",{user:users[10],method:"POST",body}),403);
    const hundred={...body,rows:Array.from({length:100},(_,i)=>({...body.rows[0],"标题":"合成批量知识"+i}))};assert.equal(expect(await http("/api/knowledge/import",{user,method:"POST",body:hundred}),201).importedCount,100);
    assert.equal(await count("SELECT COUNT(*) AS n FROM knowledge_items"),beforeItems+101);assert.equal(await count("SELECT COUNT(*) AS n FROM knowledge_item_versions"),beforeVersions+101);
    writeFileSync(path.join(runDir,"knowledge-import.json"),JSON.stringify({passed:true,synthetic:true,auditFailureRollback:true,concurrentStatuses:[201,409],unicodeRepeatStatus:409,foreignActorStatus:403,acceptedRows:101,recordedModelCalls:0,boundary:"Actual compiled Worker/HTTP/D1, synthetic accounts and knowledge; audit SQL fault injection, no real spreadsheet/business/model"},null,2));
  });

  await scenario("performance import atomic failure, 500 rows and accurate dedup: actual HTTP/D1",async()=>{
    const user=users[0],publication=await db.prepare("SELECT id FROM publication_records WHERE organization_id=? AND project_id=? AND status='published' LIMIT 1").bind(user.org,user.project).first();assert.ok(publication);
    const standard={organizationId:user.org,projectId:user.project,source:"csv",filename:"synthetic-standard.csv",rows:Array.from({length:500},(_,i)=>({publicationId:publication.id,observedAt:new Date(Date.UTC(2026,9,11,0,i)).toISOString(),views:i}))};
    const douyin={organizationId:user.org,projectId:user.project,source:"csv",format:"douyin_16",asOfAt:"2026-10-12T00:00:00.000Z",filename:"synthetic-douyin.csv",rows:Array.from({length:500},(_,i)=>({platformWorkId:"synthetic-runtime-"+i,title:"合成作品"+i,publishedAt:"2026-10-01T00:00:00.000Z",views:i}))};
    const tables=["performance_import_batches","publication_metric_snapshots","platform_works","platform_metric_import_batches","platform_metric_snapshots","platform_metric_import_errors","audit_logs"];
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)])));
    for(const [kind,body,table]of [["standard",standard,"publication_metric_snapshots"],["douyin",douyin,"platform_metric_snapshots"]]){
      const before=await snapshot(),name="synthetic_performance_"+kind;
      await db.prepare(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN NEW.views=99 BEGIN SELECT RAISE(ABORT,'synthetic late metric failure'); END`).run();
      try{expect(await http("/api/performance",{user,method:"POST",body}),500);assert.deepEqual(await snapshot(),before);}finally{await db.prepare(`DROP TRIGGER ${name}`).run();}
      const saved=expect(await http("/api/performance",{user,method:"POST",body}),201).import;assert.equal(kind==="standard"?saved.accepted_count:saved.acceptedCount,500);
      expect(await http("/api/performance",{user,method:"POST",body}),409);
    }
    const repeated={...douyin,rows:[{...douyin.rows[0],views:999}]};const result=expect(await http("/api/performance",{user,method:"POST",body:repeated}),201).import;assert.equal(result.acceptedCount,0);assert.equal(result.rejectedCount,1);
    expect(await http("/api/performance",{user:users[10],method:"POST",body:standard}),403);
    const modelCalls=await count("SELECT COUNT(*) AS n FROM model_calls")+await count("SELECT COUNT(*) AS n FROM analysis_model_calls");
    writeFileSync(path.join(runDir,"performance-import.json"),JSON.stringify({passed:true,synthetic:true,lateFaultRollback:true,standardRows:500,douyinRows:500,duplicateAccepted:0,duplicateRejected:1,foreignActorStatus:403,recordedModelCalls:modelCalls,boundary:"Actual compiled Worker/HTTP/D1 with synthetic accounts/rows and SQL faults; no real source files, provider calls, devices or field capacity"},null,2));
  });

  await scenario("metric offsets, legacy aliases and UTC analytics: actual HTTP/D1",async()=>{
    const user=users[0],publication=await db.prepare("SELECT id FROM publication_records WHERE organization_id=? AND project_id=? AND status='published' LIMIT 1").bind(user.org,user.project).first();assert.ok(publication);
    const row={publicationId:publication.id,observedAt:"2026-10-12T08:00:00+08:00",views:700};const body={organizationId:user.org,projectId:user.project,source:"csv",rows:[row]};
    expect(await http('/api/performance',{user,method:'POST',body}),201);
    expect(await http('/api/performance',{user,method:'POST',body:{...body,rows:[{...row,observedAt:'2026-10-12T00:00:00Z'}]}}),409);
    await db.prepare("UPDATE publication_metric_snapshots SET observed_at='2026-10-12T08:00:00+08:00' WHERE publication_id=? AND views=700").bind(publication.id).run();
    const duplicate=expect(await http('/api/performance',{user,method:'POST',body:{...body,rows:[{...row,observedAt:'2026-10-12T00:00:00Z',views:999}]}}),201).import;assert.equal(duplicate.accepted_count,0);
    const scopeQuery=`organizationId=${user.org}&projectId=${user.project}`;const analytics=expect(await http('/api/analytics?'+scopeQuery+'&days=30',{user}),200);assert.ok(analytics.contentPerformance.some(work=>work.publicationId===publication.id&&work.views===700));
    const platform={organizationId:user.org,projectId:user.project,source:'csv',format:'douyin_16',asOfAt:'2026-10-12T08:00:00.1234+08:00',rows:[{platformWorkId:'offset-fixture',title:'Synthetic offset work',publishedAt:'2026-10-01T08:00:00+08:00',views:800}]};
    expect(await http('/api/performance',{user,method:'POST',body:platform}),201);
    expect(await http('/api/performance',{user,method:'POST',body:{...platform,asOfAt:'2026-10-12T00:00:00.1234Z',rows:[{...platform.rows[0],publishedAt:'2026-10-01T00:00:00Z'}]}}),409);
    const stored=await db.prepare("SELECT s.as_of_at,w.published_at FROM platform_metric_snapshots s JOIN platform_works w ON w.id=s.work_id WHERE w.platform_work_id='offset-fixture'").first();assert.equal(stored.as_of_at,'2026-10-12T00:00:00.1234Z');assert.equal(stored.published_at,'2026-10-01T00:00:00.000Z');
    writeFileSync(path.join(runDir,'metric-time.json'),JSON.stringify({passed:true,synthetic:true,standardEquivalentStatus:409,legacySavedValue:700,legacyDuplicateAccepted:0,platformEquivalentStatus:409,stored,apiModels:await count('SELECT COUNT(*) AS n FROM model_calls')+await count('SELECT COUNT(*) AS n FROM analysis_model_calls'),boundary:'Actual compiled Worker/HTTP/D1, synthetic offset records; no live customer data or provider calls'},null,2));
  });
  await scenario("analysis retry/cancel atomic audit and event failures", async () => {
    const user=users[0],created=expect(await submit(user),202),jobId=created.job.id;
    const snapshot=async()=>Object.fromEntries(await Promise.all(["analysis_jobs","analysis_job_events","audit_logs"].map(async table=>{
      const key=table==="analysis_jobs"?"id":table==="analysis_job_events"?"job_id":"target_id";
      return [table,(await db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).bind(jobId).all()).results];
    })));
    const outcomes=[];
    for(const action of ["cancel","retry"]){
      if(action==="retry") await db.prepare("UPDATE analysis_jobs SET status='failed',checkpoint_stage='evidence_ready',checkpoint_json=? WHERE id=?").bind(JSON.stringify({metadata:{sentinel:true}}),jobId).run();
      for(const failure of ["audit","event"]){
        const before=await snapshot(),name=`synthetic_job_action_${action}_${failure}`;
        const table=failure==="audit"?"audit_logs":"analysis_job_events",key=failure==="audit"?"target_id":"job_id";
        await db.prepare(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN NEW.${key}='${jobId}' BEGIN SELECT RAISE(ABORT,'synthetic action ${failure} failure'); END`).run();
        try {expect(await (action==="retry"?retry:cancel)(user,jobId),500);assert.deepEqual(await snapshot(),before);} finally {await db.prepare(`DROP TRIGGER ${name}`).run();}
        outcomes.push({action,failure,rolledBack:true});
      }
      const state=expect(await (action==="retry"?retry:cancel)(user,jobId),200).job;
      assert.equal(state.status,action==="retry"?"pending":"cancelled");
    }
    assert.equal((await snapshot()).analysis_job_events.length,2);
    await db.prepare("UPDATE videos SET deleted_at=? WHERE id=?").bind(new Date().toISOString(),created.video.id).run();
    expect(await cancel(user,jobId),200);
    expect(await retry(user,jobId),404);
    assert.equal((await snapshot()).analysis_job_events.length,3);
    writeFileSync(path.join(runDir,"analysis-job-actions.json"),JSON.stringify({passed:true,synthetic:true,outcomes,deletedSourceCancelStatus:200,deletedSourceRetryStatus:404,events:3,recordedModelCalls:0,boundary:"Actual compiled HTTP/D1; synthetic accounts/source, SQL faults, no model calls; lost acknowledgement covered separately by injected unit transport"},null,2));
  });

  await scenario("large analytics preserves more than 10000 raw snapshots: actual HTTP/D1", async () => {
    const user=users[0],publication=await db.prepare("SELECT id,content_item_id FROM publication_records WHERE organization_id=? AND project_id=? AND status='published' LIMIT 1").bind(user.org,user.project).first();assert.ok(publication);
    const now=new Date().toISOString(),size=10020;
    for(let start=0;start<size;start+=250){const statements=[];
      for(let i=start;i<Math.min(start+250,size);i++)statements.push(db.prepare("INSERT INTO publication_metric_snapshots(id,organization_id,project_id,publication_id,content_item_id,observed_at,views,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind('synthetic-scale-'+i,user.org,user.project,publication.id,publication.content_item_id,new Date(Date.UTC(2026,9,12,1,0,i)).toISOString(),1000+i,user.id,now));
      await db.batch(statements);
    }
    const started=performance.now();
    const generated=expect(await http('/api/reports',{user,method:'POST',body:{organizationId:user.org,projectId:user.project,reportType:'custom',periodStart:'2026-10-11',periodEnd:'2026-10-12',title:'Synthetic large analytics'}}),201);
    const snapshot=JSON.parse(generated.report.metrics_json),work=snapshot.contentPerformance.find(row=>row.publicationId===publication.id);assert.equal(work.views,11019);
    const saved=await db.prepare('SELECT metrics_json FROM performance_reports WHERE id=?').bind(generated.report.id).first();assert.deepEqual(JSON.parse(saved.metrics_json),snapshot);
    writeFileSync(path.join(runDir,'analytics-scale.json'),JSON.stringify({passed:true,synthetic:true,rawInserted:size,latestViews:work.views,reportId:generated.report.id,reportMs:Math.round(performance.now()-started),modelCalls:await count('SELECT COUNT(*) AS n FROM model_calls')+await count('SELECT COUNT(*) AS n FROM analysis_model_calls'),boundary:'Compiled Worker/HTTP/D1 and saved report, synthetic data; fixtures removed before backup, report retained. No real accounts, provider billing, devices or field capacity.'},null,2));
    await db.prepare("DELETE FROM publication_metric_snapshots WHERE id LIKE 'synthetic-scale-%'").run();
  });

  await scenario("report generation/finalization atomic audit and reviewed revision: actual HTTP/D1",async()=>{
    const user=users[0],scope={organizationId:user.org,projectId:user.project},body={...scope,reportType:'custom',periodStart:'2026-10-03',periodEnd:'2026-10-04'};
    const state=async()=>Object.fromEntries(await Promise.all(['performance_reports','employee_work_reports','audit_logs'].map(async table=>[table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)])));
    const outcomes=[];let enterprise;
    for(const kind of ['enterprise','employee']){
      const route=kind==='enterprise'?'/api/reports':'/api/employee-reports',input=kind==='enterprise'?body:{...body,employeeUserId:user.id},action=kind==='enterprise'?'performance.report.generated':'employee.report.generated';
      for(const refresh of [false,true]){
        if(refresh){const r=expect(await http(route,{user,method:'POST',body:input}),201);if(kind==='enterprise')enterprise=r.report;}
        const before=await state();
        await db.prepare(`CREATE TRIGGER synthetic_report_audit BEFORE INSERT ON audit_logs WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic report audit failure'); END`).run();
        try {expect(await http(route,{user,method:'POST',body:input}),500);assert.deepEqual(await state(),before);}finally{await db.prepare('DROP TRIGGER synthetic_report_audit').run();}
        outcomes.push({kind,refresh,rolledBack:true});
      }
    }
    const finalRoute='/api/reports/'+enterprise.id+'/finalize',before=await state();
    await db.prepare("CREATE TRIGGER synthetic_final_audit BEFORE INSERT ON audit_logs WHEN NEW.action='performance.report.finalized' BEGIN SELECT RAISE(ABORT,'synthetic final audit failure'); END").run();
    try{expect(await http(finalRoute,{user,method:'POST',body:{...scope,expectedUpdatedAt:enterprise.updated_at}}),500);assert.deepEqual(await state(),before);}finally{await db.prepare('DROP TRIGGER synthetic_final_audit').run();}
    const refreshed=expect(await http('/api/reports',{user,method:'POST',body}),200).report;
    expect(await http(finalRoute,{user,method:'POST',body:scope}),400);
    expect(await http(finalRoute,{user,method:'POST',body:{...scope,expectedUpdatedAt:enterprise.updated_at}}),409);
    const final=expect(await http(finalRoute,{user,method:'POST',body:{...scope,expectedUpdatedAt:refreshed.updated_at}}),200).report;
    expect(await http('/api/reports',{user,method:'POST',body}),409);
    assert.equal((await db.prepare('SELECT status FROM performance_reports WHERE id=?').bind(final.id).first()).status,'final');
    writeFileSync(path.join(runDir,'report-write.json'),JSON.stringify({passed:true,synthetic:true,outcomes,finalAuditRollback:true,missingReviewedVersion:400,staleReviewedVersion:409,finalStatus:'final',models:await count('SELECT COUNT(*) AS n FROM model_calls')+await count('SELECT COUNT(*) AS n FROM analysis_model_calls'),boundary:'Actual compiled Worker/HTTP/D1 and sessions; SQL audit faults and stale reviewed version. Overlapping writers/lost receipts proven separately by deterministic SQLite transport tests; no real employee or model.'},null,2));
  });

  await scenario("workflow publication/schedule/comments atomic boundaries: actual HTTP/D1",async()=>{
    const {runWorkflowWriteChecks}=await import('./workflow-write-checks.mjs');
    await runWorkflowWriteChecks({db,http,expect,users,runDir});
  });

  await scenario("failed synthetic assistant response retains usage: actual Worker/HTTP/D1",async()=>{
    const user=users[0],before=await count('SELECT COUNT(*) AS n FROM model_calls');syntheticModelMode=true;
    try {
      const result=expect(await http('/api/project-assistant/status',{user,method:'POST',body:{organizationId:user.org,projectId:user.project}}),502);
      assert.equal(result.error.code,'PROJECT_ASSISTANT_EMPTY_RESPONSE');
    } finally {syntheticModelMode=false;}
    assert.equal(syntheticModelRequests,1);assert.equal(await count('SELECT COUNT(*) AS n FROM model_calls'),before+1);
    const row=await db.prepare("SELECT status,output_json FROM model_calls WHERE task_type='project_assistant.probe' ORDER BY created_at DESC LIMIT 1").first(),record=JSON.parse(row.output_json).modelRequests[0];
    assert.equal(row.status,'failed');assert.equal(record.status,'failed');assert.equal(record.usageKnown,true);assert.equal(record.inputTokens,12);assert.equal(record.outputTokens,8);assert.equal(record.totalTokens,20);
    writeFileSync(path.join(runDir,'model-deadline-accounting.json'),JSON.stringify({passed:true,synthetic:true,syntheticGatewayRequests:syntheticModelRequests,record,paidProviderCalls:0,externalNetworkCalls:0,boundary:'Built Worker/HTTP/D1 with intercepted synthetic gateway and known invalid output; verifies failed receipt propagation. Time bounds proved by separate deterministic clocks and local HTTP dripping body, no real provider usage/bill.'},null,2));
  });

  if (process.env.LAN_TEST_BACKUP === "1") await scenario("实际备份脚本恢复数据库与 R2：重新登录、版本关联、附件权限与继续审核发布", async () => {
    assert.equal(process.platform, "win32", "Shipped maintenance scripts require Windows");
    // Native Windows SQLite cannot use the long evidence-directory prefix.
    const installation = path.join(root, ".local/br", randomBytes(4).toString("hex"));
    const scripts = path.join(installation, "scripts"); mkdirSync(scripts, { recursive: true });
    for (const filename of ["backup-local.ps1", "restore-local.ps1", "local-state-maintenance.ps1", "analyzer-instance-lock.ps1", "verify-state-databases.mjs"]) {
      cpSync(path.join(root, "scripts", filename), path.join(scripts, filename));
    }
    const tables = ["users", "local_credentials", "projects", "videos", "media_assets", "analysis_jobs", "video_analyses", "content_items", "content_versions", "content_reviews", "publication_records", "published_copy_records", "video_library_entries", "project_video_references", "project_memory_events", "audit_logs", "video_transcripts", "video_metric_snapshots", "analysis_job_events", "knowledge_items", "knowledge_item_versions", "performance_import_batches", "publication_metric_snapshots", "platform_works", "platform_metric_import_batches", "platform_metric_snapshots", "platform_metric_import_errors", "performance_reports", "employee_work_reports", "model_calls", "content_comments", "content_schedules"];
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

  await scenario("媒体请求大小、畸形输入与50MB边界：真实HTTP", async () => {
    // Large SQL and native backup can outlast the synthetic worker's 45s
    // presence. Refresh through the real service API before testing acceptance.
    const presence=await claim("runtime-media-boundary");assert.ok([200,204].includes(presence.status));
    if(presence.status===200)expect(await release(presence.data.job),200);
    const before = await count("SELECT COUNT(*) AS n FROM videos");
    const beforeAssets = await count("SELECT COUNT(*) AS n FROM media_assets");
    const beforeModels = await count("SELECT COUNT(*) AS n FROM analysis_model_calls") + await count("SELECT COUNT(*) AS n FROM model_calls");
    const results = [];
    async function raw(route, body, contentType) {
      const started = performance.now();
      const response = await fetch(new URL(route, origin), { method: "POST", headers: { cookie: users[0].cookie, connection: "close", "content-type": contentType, "x-organization-id": users[0].org, "x-project-id": users[0].project }, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}), signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      requests.push({ scenario: currentScenario, method: "POST", route, status: response.status, ms: Math.round(performance.now() - started) });
      return { status: response.status, data };
    }
    for (const [body, expected] of [["{", 400], ["null", 400], [JSON.stringify({ url: "x".repeat(40 * 1024) }), 413]]) {
      const response = await raw("/api/videos/from-url", body, "application/json"); expect(response, expected); results.push({ kind: "invalid-link", status: response.status, code: response.data.error.code });
    }
    const malformed = await raw("/api/videos/upload", "x", "multipart/form-data"); expect(malformed, 400); results.push({ kind: "missing-boundary", status: malformed.status, code: malformed.data.error.code });
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ url: "x".repeat(40 * 1024) }))); c.close(); } });
    const chunkedResult = await raw("/api/videos/from-url", chunked, "application/json"); expect(chunkedResult, 413); results.push({ kind: "chunked-link", status: chunkedResult.status, code: chunkedResult.data.error.code });
    const maximum = 50 * 1024 * 1024;
    for (const size of [maximum + 64 * 1024 + 1, maximum + 1, maximum]) {
      const form = new FormData(); form.set("file", new Blob([new Uint8Array(size)], { type: "video/mp4" }), `synthetic-boundary-${size}.mp4`);
      const response = await http("/api/videos/upload", { user: users[0], method: "POST", body: form, headers: { "x-organization-id": users[0].org, "x-project-id": users[0].project } });
      expect(response, size > maximum ? 413 : 202);
      results.push({ kind: "file-boundary", bytes: size, status: response.status, code: response.data?.error?.code });
      if (size === maximum) {
        const video = response.data.video, job = response.data.job;
        const object = await (await mf.getR2Bucket("MEDIA")).head((await db.prepare("SELECT r2_key FROM media_assets WHERE video_id=?").bind(video.id).first()).r2_key);
        assert.equal(object.size, maximum); expect(await cancel(users[0], job.id), 200);
      } else { assert.equal(await count("SELECT COUNT(*) AS n FROM videos"), before); assert.equal(await count("SELECT COUNT(*) AS n FROM media_assets"), beforeAssets); }
    }
    assert.equal(await count("SELECT COUNT(*) AS n FROM videos"), before + 1);
    if (process.env.LAN_TEST_RESOURCE_SCRIPT) await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", process.env.LAN_TEST_RESOURCE_SCRIPT, "-RootProcessId", String(process.pid), "-OutputFile", path.join(runDir, "request-intake-resources.json")], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Resource snapshot timeout")); }, 20000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Resource snapshot failed: ${code}`)); });
    });
    const recordedModelCalls = await count("SELECT COUNT(*) AS n FROM analysis_model_calls") + await count("SELECT COUNT(*) AS n FROM model_calls") - beforeModels;
    assert.equal(recordedModelCalls, 0);
    writeFileSync(path.join(runDir, "request-intake.json"), JSON.stringify({ passed: true, synthetic: true, results, recordedModelCalls, boundary: "Actual local HTTP/Worker/D1/R2; generated opaque bytes, no media decoding, model calls or real business data" }, null, 2));
  });
  await scenario("公司月度与存储最后额度竞争：真实HTTP/D1/R2", async () => {
    const org = users[0].org, settings = await db.prepare("SELECT monthly_analysis_quota,storage_quota_bytes FROM organization_settings WHERE organization_id=?").bind(org).first();
    assert.ok(settings);
    const monthUsage = await count("SELECT COUNT(*) AS n FROM analysis_jobs WHERE organization_id=? AND created_at>=strftime('%Y-%m-01T00:00:00.000Z','now') AND created_at<strftime('%Y-%m-%dT00:00:00.000Z','now','start of month','+1 month') AND idempotency_key NOT LIKE 'material-import:%'", org);
    const reports = [];
    try {
      await db.prepare("UPDATE organization_settings SET monthly_analysis_quota=? WHERE organization_id=?").bind(monthUsage + 1, org).run();
      const monthlyUsers = [users[0], users[2]];
      const responses = await Promise.all(monthlyUsers.map(user => submit(user)));
      assert.deepEqual(responses.map(r => r.status).sort(), [202, 429]);
      const accepted = responses.find(r => r.status === 202); expect(await cancel(monthlyUsers[responses.findIndex(r => r.status === 202)], accepted.data.job.id), 200);
      reports.push({ kind: "monthly-final-slot", statuses: responses.map(r => r.status), rejectedCode: responses.find(r => r.status === 429).data.error.code });
      await db.prepare("UPDATE organization_settings SET monthly_analysis_quota=? WHERE organization_id=?").bind(settings.monthly_analysis_quota, org).run();
      const used = await count("SELECT COALESCE(SUM(MAX(size_bytes,0)),0) AS n FROM media_assets WHERE organization_id=? AND status='active'", org);
      const payloads = [Buffer.from("quota0"), Buffer.from("quota1")];
      await db.prepare("UPDATE organization_settings SET storage_quota_bytes=? WHERE organization_id=?").bind(used + payloads[0].length, org).run();
      const uploaded = await Promise.all(payloads.map(bytes => { const form = new FormData(); form.set("file", new Blob([bytes], { type: "video/mp4" }), "quota.mp4"); return http("/api/videos/upload", { user: users[0], method: "POST", body: form, headers: { "x-organization-id": org, "x-project-id": users[0].project } }); }));
      assert.deepEqual(uploaded.map(r => r.status).sort(), [202, 429]);
      const success = uploaded.find(r => r.status === 202); const job = success.data.job;
      // Isolated lease injection exercises the actual protected artifact route;
      // no external processor runs or produces a paid request.
      await db.prepare("UPDATE analysis_jobs SET status='extracting',version=1,lease_owner='quota-fixture',lease_expires_at=? WHERE id=?").bind(new Date(Date.now() + 60000).toISOString(), job.id).run();
      const artifact = await http(`/api/internal/analysis-jobs/${job.id}/artifacts`, { service: true, method: "POST", body: {}, headers: { "x-worker-id": "quota-fixture", "x-job-version": "1", "x-artifact-kind": "report", "x-artifact-filename": "quota.json" } });
      expect(artifact, 429); assert.equal(artifact.data.error.code, "STORAGE_QUOTA_EXCEEDED");
      const object = await (await mf.getR2Bucket("MEDIA")).head((await db.prepare("SELECT r2_key FROM media_assets WHERE video_id=?").bind(success.data.video.id).first()).r2_key);
      assert.equal(object.size, payloads[0].length);
      assert.equal(await count("SELECT SUM(size_bytes) AS n FROM media_assets WHERE organization_id=? AND status='active'", org), used + payloads[0].length);
      assert.equal(await count("SELECT COUNT(*) AS n FROM media_assets WHERE analysis_job_id=?", job.id), 0);
      await db.prepare("UPDATE analysis_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").bind(job.id).run();
      reports.push({ kind: "storage-final-slot", statuses: uploaded.map(r => r.status), rejectedCode: uploaded.find(r => r.status === 429).data.error.code, artifactStatus: artifact.status, artifactCode: artifact.data.error.code });
    } finally {
      await db.prepare("UPDATE organization_settings SET monthly_analysis_quota=?,storage_quota_bytes=? WHERE organization_id=?").bind(settings.monthly_analysis_quota, settings.storage_quota_bytes, org).run();
    }
    writeFileSync(path.join(runDir, "quota-concurrency.json"), JSON.stringify({ passed: true, synthetic: true, reports, boundary: "Actual local HTTP/D1/R2; synthetic accounts and bytes, artifact lease set only in this isolated fixture; no model or field business test" }, null, 2));
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
    authProfile: process.env.LAN_TEST_DEV_AUTH === "1" ? "LAN with stale local-development and trusted-proxy flags enabled" : "Commercial password-only authentication",
    scenarios, metrics: { requests: requests.length, http5xx: requests.filter(r => r.status >= 500).length, p50Ms: timings[Math.floor(timings.length * .5)] ?? 0, p95Ms: timings[Math.floor(timings.length * .95)] ?? 0, maxMs: timings.at(-1) ?? 0 }, requests,
  };
  writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(runDir, "report.md"), `# 局域网运行时测试\n\n时间：${report.at}\n\n结果：${report.passed ? "通过" : "失败"}\n\n${report.boundary}\n\n请求数：${report.metrics.requests}，P95：${report.metrics.p95Ms} ms，最大：${report.metrics.maxMs} ms。\n\n5xx 包括主动注入的分析服务离线 503；逐条请求在 report.json。\n\n| 场景 | 结果 |\n|---|---|\n${scenarios.map(s => `| ${s.name} | ${s.passed ? "通过" : `失败：${s.error.replaceAll("\n", " ").replaceAll("|", "/")}`} |`).join("\n")}\n`);
  console.log(JSON.stringify({ passed: report.passed, ...report.metrics, report: path.join(runDir, "report.md") }));
}
