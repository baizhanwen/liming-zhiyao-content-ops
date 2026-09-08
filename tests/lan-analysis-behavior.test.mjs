import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const now = "2026-09-01T00:00:00.000Z";

// Run the actual route and helper code with SQLite transactions, replacing only
// host bindings, login and paid/external services. No production data is opened.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const name of readdirSync(path.join(root, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(root, "drizzle", name), "utf8"));
  }
  sqlite.prepare("INSERT INTO users (id, auth_subject, email, status, created_at, updated_at) VALUES ('user-1', 'user-1', 'test@example.invalid', 'active', ?, ?)").run(now, now);
  sqlite.prepare("INSERT INTO organizations (id, name, slug, created_by, created_at, updated_at) VALUES ('org-1', 'Test', 'test', 'user-1', ?, ?)").run(now, now);
  for (const id of ["project-1", "project-2"]) {
    sqlite.prepare("INSERT INTO projects (id, organization_id, name, client_name, status, created_by, updated_by, created_at, updated_at) VALUES (?, 'org-1', ?, 'Test', 'active', 'user-1', 'user-1', ?, ?)").run(id, id, now, now);
  }
  const db = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        execute() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
        async run() { return statement.execute(); },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const objects = new Map();
  const bucket = {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
  };
  const readiness = { analyzerOnline: true, credentialConfigured: true, modelConfigured: true, publicLinkCookieConfigured: true };
  let arrivals = 0;
  let expected = 0;
  let release;
  let barrier = Promise.resolve();
  function synchronizeSubmissions(count) {
    arrivals = 0;
    expected = count;
    barrier = new Promise((resolve) => { release = resolve; });
  }
  const runtime = {
    getD1: () => db,
    getMediaBucket: () => bucket,
    ensureUser: async () => ({ id: "user-1" }),
    getProjectAccess: async (_subject, org, project) => org === "org-1" && ["project-1", "project-2"].includes(project) ? { projectRole: "member" } : null,
    canWriteProjectAccess: (access) => Boolean(access?.projectRole),
    sha256Hex: async (bytes) => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
    hashInvitationToken: async (value) => runtime.sha256Hex(new TextEncoder().encode(value)),
  };
  const mocks = new Map([
    ["cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "test-service-token" } }],
    [path.join(root, "db/runtime.ts"), runtime],
    [path.join(root, "lib/request-auth.ts"), { readRequestIdentity: async () => ({ authSubject: "user-1" }) }],
    [path.join(root, "lib/analyzer-readiness.ts"), { readAnalyzerReadiness: async () => readiness, analyzerReadinessError: () => null }],
    [path.join(root, "lib/operations.ts"), { checkOrganizationQuota: async (_org, _user, resource) => {
      if (resource === "analyses") {
        arrivals++;
        if (arrivals === expected) release?.();
        await barrier;
      }
      return { allowed: true };
    } }],
    [path.join(root, "lib/video-library.ts"), { upsertProjectVideoReference: ({ db: target, ...input }) => load("lib/video-reference-state.ts").upsertProjectVideoReference(target, input) }],
  ]);
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (mocks.has(filename)) return mocks.get(filename);
    if (cache.has(filename)) return cache.get(filename);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule.exports);
    new Function("require", "module", "exports", code)((specifier) => {
      if (mocks.has(specifier)) return mocks.get(specifier);
      if (!specifier.startsWith(".")) throw new Error(`Unexpected external import: ${specifier}`);
      return load(path.resolve(path.dirname(filename), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`));
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const submit = (project = "project-1", url = "https://www.douyin.com/video/1234567890123456789") => load("app/api/videos/from-url/route.ts").POST(new Request("http://localhost/api/videos/from-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: "org-1", projectId: project, url }) }));
  const claim = (worker = "worker-1") => load("app/api/internal/analysis-jobs/claim/route.ts").POST(new Request("http://localhost/api/internal/analysis-jobs/claim", { method: "POST", headers: { authorization: "Bearer test-service-token", "content-type": "application/json" }, body: JSON.stringify({ workerId: worker, leaseSeconds: 300 }) }));
  return { sqlite, db, objects, load, submit, claim, synchronizeSubmissions };
}

test("simultaneous same-project URL submissions keep one task and return a useful conflict", async (t) => {
  const f = fixture(t);
  f.synchronizeSubmissions(8);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.submit()));
  assert.equal(responses.filter((response) => response.status === 202).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("simultaneous cross-project URL submissions can retry into a shared reference", async (t) => {
  const f = fixture(t);
  f.synchronizeSubmissions(2);
  const responses = await Promise.all([f.submit(), f.submit("project-2")]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const project = responses[0].status === 409 ? "project-1" : "project-2";
  const repeated = await f.submit(project);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).reused, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("simultaneous uploads roll back duplicate rows and only delete their own objects", async (t) => {
  const f = fixture(t);
  f.synchronizeSubmissions(4);
  const upload = () => {
    const form = new FormData();
    form.set("file", new File(["test media"], "same.mp4", { type: "video/mp4" }));
    return f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/api/videos/upload", { method: "POST", headers: { "x-organization-id": "org-1", "x-project-id": "project-1" }, body: form }));
  };
  const responses = await Promise.all(Array.from({ length: 4 }, upload));
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409, 409, 409]);
  assert.equal(f.objects.size, 1);
  const asset = f.sqlite.prepare("SELECT r2_key FROM media_assets").get();
  assert.ok(f.objects.has(asset.r2_key));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("concurrent claims never give the same live task to two workers", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 6; index++) assert.equal((await f.submit("project-1", `https://www.douyin.com/video/123456789012345678${index}`)).status, 202);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => f.claim(`worker-${index}`)));
  const jobs = await Promise.all(responses.filter((response) => response.status === 200).map(async (response) => (await response.json()).job));
  assert.equal(jobs.length, 6);
  assert.equal(new Set(jobs.map((job) => job.id)).size, 6);
  assert.equal(responses.filter((response) => response.status === 204).length, 6);
});

for (const checkpoint of [false, true]) {
  test(`expired lease restarts with valid progress (checkpoint=${checkpoint})`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.submit()).status, 202);
    const original = (await (await f.claim()).json()).job;
    f.sqlite.prepare("UPDATE analysis_jobs SET status = 'analyzing', progress = 95, lease_expires_at = ?, checkpoint_stage = ?, checkpoint_json = ? WHERE id = ?").run(now, checkpoint ? "evidence_ready" : null, checkpoint ? '{"checkpoint_version":1}' : null, original.id);
    const job = (await (await f.claim("worker-2")).json()).job;
    const heartbeat = f.load("app/api/internal/analysis-jobs/[jobId]/heartbeat/route.ts");
    const send = (worker, version) => heartbeat.POST(new Request("http://localhost/heartbeat", { method: "POST", headers: { authorization: "Bearer test-service-token", "content-type": "application/json" }, body: JSON.stringify({ workerId: worker, version, status: checkpoint ? "analyzing" : "downloading", progress: checkpoint ? 84 : 5, stage: "恢复分析", leaseSeconds: 300 }) }), { params: Promise.resolve({ jobId: job.id }) });
    assert.equal((await send("worker-1", original.version)).status, 409);
    const resumed = await send("worker-2", job.version);
    assert.equal(resumed.status, 200, JSON.stringify(await resumed.json()));
  });
}

test("project queue includes other projects without exposing their task contents", async (t) => {
  const f = fixture(t);
  await f.submit();
  await f.submit("project-2", "https://www.douyin.com/video/1234567890123456799");
  await f.claim();
  const response = await f.load("app/api/videos/route.ts").GET(new Request("http://localhost/api/videos?organizationId=org-1&projectId=project-1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jobs.length, 1);
  assert.equal(body.videos.length, 1);
  assert.equal(body.queue.waitingCount, 1);
  assert.equal(body.queue.runningCount, 1);
});

test("ten simultaneous client submissions persist ten distinct tasks across projects", async (t) => {
  const f = fixture(t);
  f.synchronizeSubmissions(10);
  const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => f.submit(index % 2 ? "project-1" : "project-2", `https://www.douyin.com/video/123456789012345678${index}`)));
  assert.ok(responses.every((response) => response.status === 202));
  const submitted = await Promise.all(responses.map(async (response) => (await response.json()).job.id));
  const claimed = [];
  for (let index = 0; index < 10; index++) {
    const job = (await (await f.claim()).json()).job;
    claimed.push(job.id);
    // Simulate a completed worker turn; real models and Douyin are a separate
    // on-site acceptance gate, not part of this scheduling test.
    f.sqlite.prepare("UPDATE analysis_jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(job.id);
  }
  assert.deepEqual(new Set(claimed), new Set(submitted));
  assert.equal((await f.claim()).status, 204);
});

test("simultaneous reanalysis requests create only one new active task", async (t) => {
  const f = fixture(t);
  const videoId = (await (await f.submit()).json()).video.id;
  f.sqlite.prepare("UPDATE analysis_jobs SET status = 'completed'").run();
  f.synchronizeSubmissions(8);
  const handler = f.load("app/api/videos/[videoId]/reanalyze/route.ts");
  const responses = await Promise.all(Array.from({ length: 8 }, () => handler.POST(new Request("http://localhost/reanalyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: "org-1", projectId: "project-1" }) }), { params: Promise.resolve({ videoId }) })));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status = 'pending'").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'analysis_job.reanalysis_created'").get().n, 1);
});

test("an old failed job cannot be retried while a newer analysis is active", async (t) => {
  const f = fixture(t);
  const created = await (await f.submit()).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status = 'failed'").run();
  const reanalyze = await f.load("app/api/videos/[videoId]/reanalyze/route.ts").POST(new Request("http://localhost/reanalyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: "org-1", projectId: "project-1" }) }), { params: Promise.resolve({ videoId: created.video.id }) });
  assert.equal(reanalyze.status, 201);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(new Request("http://localhost/retry", { method: "POST" }), { params: Promise.resolve({ jobId: created.job.id }) });
  assert.equal(retried.status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status = 'pending'").get().n, 1);
});
