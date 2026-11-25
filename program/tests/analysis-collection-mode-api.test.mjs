import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = new Date().toISOString(), projectId = crypto.randomUUID(), otherProjectId = crypto.randomUUID();
  for (const id of [projectId, otherProjectId]) f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, owner.organizationId, "Synthetic", "Synthetic", owner.userId, owner.userId, now, now);
  const environment = { ANALYZER_SERVICE_TOKEN: "synthetic-service-token", ANALYZER_LLM_API_KEY: "synthetic-model-key", ANALYZER_LLM_BASE_URL: "https://model.example.invalid/v1", ANALYZER_LLM_MODEL: "synthetic-model", ANALYZER_LLM_PROVIDER: "synthetic-provider" };
  f.mockModule("cloudflare:workers", { env: environment });
  f.mock("lib/model-settings.ts", { readEffectiveModelRuntime: async () => environment });
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, current: 0, limit: 1000 }) });
  f.sqlite.prepare("INSERT INTO analyzer_workers(worker_id,status,started_at,last_seen_at,updated_at,browser_auth_status,browser_auth_checked_at) VALUES('collection-worker','online',?,?,?,'logged_in',?)").run(now, now, now, now);
  const objects = new Map(), reads = [];
  const bucket = {
    async head(key) { reads.push(key); const value = objects.get(key); return value ? { size: value.contents.length, customMetadata: value.metadata } : null; },
    async get(key) { reads.push(key); const value = objects.get(key); return value ? { body: new Response(value.contents).body, size: value.contents.length } : null; },
    async put(key, contents, options) { objects.set(key, { contents: typeof contents === "string" ? contents : "synthetic-media", metadata: options?.customMetadata }); return { key }; },
    async delete(key) { objects.delete(key); },
  };
  Object.assign(f.runtime, {
    getProjectAccess: async (_subject, org, project) => org === owner.organizationId && [projectId, otherProjectId].includes(project) ? { userId: owner.userId, organizationId: org, projectId: project, organizationRole: "admin", projectRole: null } : null,
    canWriteProjectAccess: () => true, getMediaBucket: () => bucket, getLegacyMediaBucket: () => null,
    hashInvitationToken: async value => createHash("sha256").update(value).digest("hex"),
  });
  const scope = { organizationId: owner.organizationId, projectId };
  const request = (body = {}, headers = {}) => new Request("http://localhost/synthetic", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const submit = (options = {}) => f.load("app/api/videos/from-url/route.ts").POST(request({ ...scope, url: "https://www.douyin.com/video/1234567890123456789", visualAnalysisMode: "hybrid", ...options }));
  const claim = () => f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(request({ workerId: "collection-worker", leaseSeconds: 300 }, { authorization: "Bearer synthetic-service-token" }));
  const retry = (jobId, options = {}) => f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(request(options), { params: Promise.resolve({ jobId }) });
  const reanalyze = (videoId, options = {}) => f.load("app/api/videos/[videoId]/reanalyze/route.ts").POST(request({ ...scope, ...options }), { params: Promise.resolve({ videoId }) });
  const finish = id => f.sqlite.prepare("UPDATE analysis_jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(id);
  const cookieKey = f.load("lib/douyin-cookie-snapshot.ts").douyinCookieObjectKey;
  const configure = (org = owner.organizationId) => objects.set(cookieKey(org), { contents: "# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tsynthetic-session\n", metadata: { updatedAt: now } });
  const snapshot = (id, headers = {}) => f.load("app/api/internal/analysis-jobs/[jobId]/cookies/route.ts").GET(new Request("http://localhost/cookies", { headers: { authorization: "Bearer synthetic-service-token", "x-worker-id": "collection-worker", ...headers } }), { params: Promise.resolve({ jobId: id }) });
  return { ...f, owner, scope, otherProjectId, now, bucket, objects, reads, cookieKey, configure, request, submit, claim, retry, reanalyze, finish, snapshot };
}

test("collection migration defaults historical rows to anonymous and constrains new modes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY); INSERT INTO analysis_jobs VALUES('old')");
    db.exec(readFileSync(new URL("../drizzle/0056_analysis_collection_mode.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT collection_mode FROM analysis_jobs").get().collection_mode, "anonymous");
    assert.throws(() => db.exec("INSERT INTO analysis_jobs(id,collection_mode) VALUES('invalid','browser')"), /CHECK constraint/);
  } finally { db.close(); }
});

test("anonymous remains default even with host login and Cookie only accepts this organization's upload", async t => {
  const f = await fixture(t);
  const readiness = await f.load("lib/analyzer-readiness.ts").readAnalyzerReadiness(f.owner.organizationId);
  assert.equal(readiness.browserLoginDetected, true); assert.equal(readiness.uploadedCookieConfigured, false);
  const anonymous = await f.submit(); assert.equal(anonymous.status, 202); const saved = await anonymous.json();
  assert.equal(saved.job.collection_mode, "anonymous"); f.finish(saved.job.id);
  f.configure("another-organization");
  const missing = await f.submit({ projectId: f.otherProjectId, url: "https://www.douyin.com/video/2234567890123456789", collectionMode: "cookie" });
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, "ANALYZER_COOKIE_REQUIRED");
  f.configure();
  const ready = await f.load("lib/analyzer-readiness.ts").readAnalyzerReadiness(f.owner.organizationId);
  assert.equal(ready.uploadedCookieConfigured, true); assert.equal(ready.cookieUpdatedAt, f.now); assert.equal(ready.publicLinkCookieConfigured, false);
  const cookie = await f.submit({ url: "https://www.douyin.com/video/2234567890123456789", collectionMode: "cookie" });
  assert.equal(cookie.status, 202); const data = await cookie.json(); assert.equal(data.job.collection_mode, "cookie");
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.collection_mode, "cookie"); assert.equal(claimed.source.collection_mode, "cookie");
  const snapshot = await f.snapshot(claimed.id, { "x-worker-attempt": String(claimed.attempt_count), "x-job-version": String(claimed.version) });
  assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get("cache-control"), "no-store"); await snapshot.text();
  assert.equal(f.reads.at(-1), f.cookieKey(f.owner.organizationId));
});

for (const stalled of [false, true]) test(`anonymous submissions skip optional Cookie storage (${stalled ? "stalled" : "rejected"}) and status lookup is bounded`, { timeout: 3000 }, async t => {
  const f = await fixture(t); let headCalls = 0;
  f.bucket.head = () => { headCalls += 1; return stalled ? new Promise(() => {}) : Promise.reject(new Error("Synthetic Cookie storage unavailable")); };
  const response = await f.submit(); assert.equal(response.status, 202); assert.equal(headCalls, 0);
  const { readAnalyzerReadiness, analyzerReadinessError } = f.load("lib/analyzer-readiness.ts");
  const readiness = await readAnalyzerReadiness(f.scope.organizationId);
  assert.equal(headCalls, 1); assert.equal(readiness.uploadedCookieConfigured, false);
  assert.equal(analyzerReadinessError(readiness, false), null);
  assert.equal(analyzerReadinessError(readiness, true).code, "ANALYZER_COOKIE_REQUIRED");
});

test("list, detail and pending diagnostics expose the persisted selection and actual uploaded Cookie readiness", async t => {
  const f = await fixture(t); f.configure(); const original = await (await f.submit({ collectionMode: "cookie" })).json();
  const query = `?organizationId=${f.scope.organizationId}&projectId=${f.scope.projectId}`;
  const listed = await f.load("app/api/videos/route.ts").GET(new Request(`http://localhost/videos${query}`));
  assert.equal(listed.status, 200, await listed.clone().text()); const list = await listed.json();
  assert.equal(list.jobs.find(job => job.id === original.job.id).collection_mode, "cookie");
  assert.equal(list.service.uploadedCookieConfigured, true); assert.equal(list.service.publicLinkCookieConfigured, false);
  const route = f.load("app/api/videos/[videoId]/route.ts"), context = { params: Promise.resolve({ videoId: original.video.id }) };
  const detail = await route.GET(new Request(`http://localhost/detail${query}`), context);
  assert.equal(detail.status, 200, await detail.clone().text()); const data = await detail.json();
  assert.equal(data.job.collection_mode, "cookie"); assert.equal(data.latestJob.collection_mode, "cookie");
  const diagnostic = await route.GET(new Request(`http://localhost/detail${query}&export=json`), context);
  assert.equal(diagnostic.status, 200); const exported = await diagnostic.json();
  assert.equal(exported.diagnostics.collectionMode, "cookie"); assert.equal(exported.diagnostics.jobSnapshot.collection_mode, "cookie");
});

for (const status of ["failed", "cancelled"]) test(`${status} URL retries can switch collection before evidence acquisition, and retain it by default`, async t => {
  const f = await fixture(t), original = await (await f.submit()).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status=?,checkpoint_stage='evidence_ready',checkpoint_json='{broken' WHERE id=?").run(status, original.job.id);
  const missing = await f.retry(original.job.id, { collectionMode: "cookie" }); assert.equal(missing.status, 503);
  assert.equal(f.sqlite.prepare("SELECT collection_mode FROM analysis_jobs WHERE id=?").get(original.job.id).collection_mode, "anonymous");
  f.configure(); const response = await f.retry(original.job.id, { collectionMode: "cookie" }); assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).job.collection_mode, "cookie");
  const switched = f.sqlite.prepare("SELECT collection_mode,checkpoint_stage,checkpoint_json FROM analysis_jobs WHERE id=?").get(original.job.id);
  assert.equal(switched.collection_mode, "cookie"); assert.equal(switched.checkpoint_stage, null); assert.equal(switched.checkpoint_json, null);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed' WHERE id=?").run(original.job.id);
  assert.equal((await f.retry(original.job.id)).status, 200);
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.source.collection_mode, "cookie");
});

test("evidence retries preserve the selected mode without requiring a new Cookie, and reject misleading switches", async t => {
  const f = await fixture(t); f.configure(); const original = await (await f.submit({ collectionMode: "cookie" })).json();
  const checkpoint = { checkpoint_version: 1, media: {}, transcript: {}, visuals: {}, visual_analysis_mode: "hybrid", visual_sampling_level: "quick" };
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed',checkpoint_stage='evidence_ready',checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), original.job.id);
  f.objects.clear(); const switched = await f.retry(original.job.id, { collectionMode: "anonymous" });
  assert.equal(switched.status, 409); assert.equal((await switched.json()).error.code, "ANALYSIS_COLLECTION_MODE_MISMATCH");
  assert.equal((await f.retry(original.job.id)).status, 200);
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.source.collection_mode, "cookie"); assert.equal(claimed.checkpoint.checkpoint_version, 1);
});

test("partial and active URL tasks cannot switch collection modes", async t => {
  const f = await fixture(t), original = await (await f.submit()).json(); f.configure();
  for (const status of ["partial", "pending", "downloading"]) {
    f.sqlite.prepare("UPDATE analysis_jobs SET status=? WHERE id=?").run(status, original.job.id);
    assert.equal((await f.retry(original.job.id, { collectionMode: "cookie" })).status, 409);
  }
});

test("URL reanalysis and manual transcript derivatives inherit collection, while new explicit analyses can change it", async t => {
  const f = await fixture(t); f.configure(); const original = await (await f.submit({ collectionMode: "cookie" })).json(); f.finish(original.job.id);
  const inherited = await f.reanalyze(original.video.id); assert.equal(inherited.status, 201); const next = await inherited.json(); assert.equal(next.job.collection_mode, "cookie"); f.finish(next.job.id);
  const manual = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request({ ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: "人工确认原文" }], reanalyze: true }), { params: Promise.resolve({ videoId: original.video.id }) });
  assert.equal(manual.status, 201); const corrected = await manual.json(); assert.equal(corrected.job.collection_mode, "cookie"); f.finish(corrected.job.id);
  const switched = await f.reanalyze(original.video.id, { collectionMode: "anonymous", task: "transcript" }); assert.equal(switched.status, 201); const nextTranscript = await switched.json(); assert.equal(nextTranscript.job.collection_mode, "anonymous");
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.source.collection_mode, "anonymous"); assert.equal(claimed.source.transcript_only, true);
});

test("uploads always use anonymous source settings and cannot switch collection in retry", async t => {
  const f = await fixture(t), form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("collectionMode", "cookie"); form.set("visualAnalysisMode", "hybrid");
  const response = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.scope.projectId }, body: form }));
  assert.equal(response.status, 202); const uploaded = await response.json(); assert.equal(uploaded.job.collection_mode, "anonymous");
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed' WHERE id=?").run(uploaded.job.id);
  assert.equal((await f.retry(uploaded.job.id, { collectionMode: "cookie" })).status, 409);
  f.finish(uploaded.job.id); const reanalyzed = await f.reanalyze(uploaded.video.id, { collectionMode: "cookie" });
  assert.equal(reanalyzed.status, 201); assert.equal((await reanalyzed.json()).job.collection_mode, "anonymous");
});

test("Cookie snapshots require cookie URL, live status, owner and current attempt or legacy revision", async t => {
  const f = await fixture(t); f.configure(); const created = await (await f.submit({ collectionMode: "cookie" })).json();
  const claimed = (await (await f.claim()).json()).job;
  const headers = { "x-worker-attempt": String(claimed.attempt_count) };
  assert.equal((await f.snapshot(claimed.id)).status, 400);
  assert.equal((await f.snapshot(claimed.id, { "x-worker-attempt": "0" })).status, 400);
  assert.equal((await f.snapshot(claimed.id, { "x-job-version": String(claimed.version) })).status, 200);
  f.sqlite.prepare("UPDATE analysis_jobs SET version=version+1 WHERE id=?").run(claimed.id);
  assert.equal((await f.snapshot(claimed.id, { "x-job-version": String(claimed.version) })).status, 409);
  assert.equal((await f.snapshot(claimed.id, headers)).status, 200);
  for (const [column, value] of [["collection_mode", "anonymous"], ["status", "pending"], ["lease_owner", "other-worker"], ["lease_expires_at", "2000-01-01T00:00:00.000Z"], ["attempt_count", claimed.attempt_count + 1], ["source_type", "upload"]]) {
    const before = f.sqlite.prepare(`SELECT ${column} FROM analysis_jobs WHERE id=?`).get(claimed.id)[column];
    f.sqlite.prepare(`UPDATE analysis_jobs SET ${column}=? WHERE id=?`).run(value, claimed.id);
    const readCount = f.reads.length; assert.equal((await f.snapshot(claimed.id, headers)).status, 409); assert.equal(f.reads.length, readCount);
    f.sqlite.prepare(`UPDATE analysis_jobs SET ${column}=? WHERE id=?`).run(before, claimed.id);
  }
  f.bucket.get = async () => { f.sqlite.prepare("UPDATE analysis_jobs SET status='cancelled' WHERE id=?").run(created.job.id); return { body: new Response("synthetic snapshot").body, size: 18 }; };
  assert.equal((await f.snapshot(claimed.id, headers)).status, 409);
});

test("invalid collection values are rejected before creating or mutating a task", async t => {
  const f = await fixture(t);
  for (const value of [null, false, 1, {}, "browser", "cookies"]) assert.equal((await f.submit({ collectionMode: value })).status, 400);
  const original = await (await f.submit()).json(); f.finish(original.job.id);
  assert.equal((await f.reanalyze(original.video.id, { collectionMode: "browser" })).status, 400);
  assert.equal((await f.retry(original.job.id, { collectionMode: null })).status, 400);
  const manual = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request({ ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: "原文" }], reanalyze: true, collectionMode: "browser" }), { params: Promise.resolve({ videoId: original.video.id }) }); assert.equal(manual.status, 400);
});

test("Cookie uploads and deletion use the existing project write scope", async t => {
  const f = await fixture(t), form = new FormData(); form.set("file", new File(["# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tsynthetic-session\n"], "cookies.txt", { type: "text/plain" }));
  const route = f.load("app/api/analyzer/cookies/route.ts"), headers = { "x-organization-id": f.scope.organizationId, "x-project-id": f.scope.projectId };
  f.runtime.canWriteProjectAccess = () => false;
  assert.equal((await route.POST(new Request("http://localhost/cookies", { method: "POST", headers, body: form }))).status, 403);
  f.configure(); assert.equal((await route.DELETE(new Request("http://localhost/cookies", { method: "DELETE", headers }))).status, 403); assert.equal(f.objects.size, 1);
  f.runtime.canWriteProjectAccess = () => true;
  assert.equal((await route.POST(new Request("http://localhost/cookies", { method: "POST", headers, body: form }))).status, 201);
  assert.equal((await route.DELETE(new Request("http://localhost/cookies", { method: "DELETE", headers }))).status, 200); assert.equal(f.objects.size, 0);
});

test("diagnostics retain historical report collection separately from the later task selection", async t => {
  const f = await fixture(t), { buildAnalysisDiagnosticExport } = f.load("lib/analysis-diagnostic-export.ts");
  const input = { exportedAt: f.now, ...f.scope, sourceProjectId: f.scope.projectId, video: { id: "synthetic" }, analysis: { id: "report", report: { analysis_meta: { collection_mode: "cookie" } } }, job: { collection_mode: "anonymous" }, events: [], eventCount: 0, eventsThrough: f.now };
  assert.equal(buildAnalysisDiagnosticExport(input).diagnostics.collectionMode, "cookie");
  input.analysis.report = {}; assert.equal(buildAnalysisDiagnosticExport(input).diagnostics.collectionMode, "anonymous");
  input.analysis = null; input.job.collection_mode = "cookie"; assert.equal(buildAnalysisDiagnosticExport(input).diagnostics.collectionMode, "cookie");
});

test("a submitted share message schedules a single TikHub enrichment for the newly stored video", async t => {
  const f = await fixture(t);
  const pending = [], calls = [];
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic" }, waitUntil: task => pending.push(task) });
  f.mock("lib/video-metadata-runtime.ts", {
    async collectVideoMetadata(scope) {
      const video = f.sqlite.prepare("SELECT source_url FROM videos WHERE id=? AND project_id=? AND organization_id=?")
        .get(scope.videoId, scope.projectId, scope.organizationId);
      calls.push({ url: video.source_url, userId: scope.userId });
    },
  });
  const options = { url: "复制打开抖音看看 https://v.douyin.com/test123/ 视频" };
  const first = await f.submit(options);
  assert.equal(first.status, 202);
  await Promise.all(pending);
  assert.deepEqual(calls, [{ url: "https://v.douyin.com/test123/", userId: f.owner.userId }]);
  await f.submit(options);
  assert.equal(pending.length, 1);
});

test("a metadata collection failure leaves the accepted video and analysis job intact", async t => {
  const f = await fixture(t);
  const pending = [];
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic" }, waitUntil: task => pending.push(task) });
  f.mock("lib/video-metadata-runtime.ts", {
    async collectVideoMetadata() { throw new Error("synthetic settings failure"); },
  });
  const submission = await f.submit({ url: "https://v.douyin.com/test123/" });
  assert.equal(submission.status, 202);
  const { video, job } = await submission.json();
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(f.sqlite.prepare("SELECT id FROM videos WHERE id=?").get(video.id).id, video.id);
  assert.equal(f.sqlite.prepare("SELECT video_id FROM analysis_jobs WHERE id=?").get(job.id).video_id, video.id);
});
