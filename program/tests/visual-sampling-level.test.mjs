import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  await f.initialize();
  const owner = f.sqlite.prepare("SELECT id FROM users LIMIT 1").get();
  const organization = f.sqlite.prepare("SELECT id FROM organizations LIMIT 1").get();
  const projectId = crypto.randomUUID(), otherProjectId = crypto.randomUUID(), now = new Date().toISOString();
  f.identity.userId = owner.id;
  for (const id of [projectId, otherProjectId]) f.sqlite.prepare("INSERT INTO projects (id,organization_id,name,client_name,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,?,?)")
    .run(id, organization.id, "Test project", "Test client", owner.id, owner.id, now, now);
  Object.assign(f.runtime, {
    getProjectAccess: async (_subject, org, project) => org === organization.id && [projectId, otherProjectId].includes(project)
      ? { userId: owner.id, organizationId: org, projectId: project, organizationRole: "admin", projectRole: null } : null,
    canWriteProjectAccess: () => true,
    hashInvitationToken: async value => createHash("sha256").update(value).digest("hex"),
    getMediaBucket: () => ({ head: async () => null, put: async () => ({ size: 5 }), delete: async () => {} }), getLegacyMediaBucket: () => null,
  });
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit: 1000, current: 0 }) });
  f.mock("lib/analyzer-readiness.ts", { readAnalyzerReadiness: async () => ({}), analyzerReadinessError: () => null });
  const scope = { organizationId: organization.id, projectId };
  const request = (url, body, internal = false) => new Request(`http://localhost${url}`, {
    method: "POST", headers: { "content-type": "application/json", ...(internal ? { authorization: "Bearer synthetic-service-token" } : {}) }, body: JSON.stringify(body),
  });
  const submit = (options = {}) => f.load("app/api/videos/from-url/route.ts").POST(request("/api/videos/from-url", {
    ...scope, url: "https://www.douyin.com/video/1234567890123456789", visualAnalysisMode: "hybrid", ...options,
  }));
  const claim = () => f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(request("/claim", { workerId: "test-worker", leaseSeconds: 300 }, true));
  const finish = id => f.sqlite.prepare("UPDATE analysis_jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(id);
  const reanalyze = (videoId, options = {}) => f.load("app/api/videos/[videoId]/reanalyze/route.ts").POST(request("/reanalyze", { ...scope, ...options }), { params: Promise.resolve({ videoId }) });
  return { ...f, scope, projectId, otherProjectId, submit, claim, finish, reanalyze, request };
}

const levels = ["quick", "balanced", "detailed"];

test("sampling migration preserves historical NULL and rejects unknown explicit values", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY); INSERT INTO analysis_jobs VALUES('historical')");
    db.exec(readFileSync(new URL("../drizzle/0054_analysis_visual_sampling.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT visual_sampling_level FROM analysis_jobs").get().visual_sampling_level, null);
    assert.throws(() => db.exec("INSERT INTO analysis_jobs(id,visual_sampling_level) VALUES('invalid','legacy')"), /CHECK constraint failed/);
  } finally { db.close(); }
});

for (const level of levels) test(`${level} survives submission, evidence checkpoint, failed retry, next claim and completion`, async t => {
  const f = await fixture(t);
  const response = await f.submit({ visualSamplingLevel: level, analysisProfile: "max" });
  assert.equal(response.status, 202); const created = await response.json();
  assert.equal(created.job.visual_sampling_level, level); assert.equal(created.job.analysis_profile, "max");
  assert.equal(created.job.visual_analysis_mode, "hybrid");
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.visual_sampling_level, level); assert.equal(job.source.visual_sampling_level, level);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(job.id);
  const checkpoint = { checkpoint_version: 1, visual_sampling_level: level, media: {}, transcript: {}, visuals: {} };
  const saved = await f.load("app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts").POST(f.request("/checkpoint", { workerId: "test-worker", version: job.version, attempt: job.attempt_count, stage: "evidence_ready", checkpoint }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(saved.status, 201);
  const current = f.sqlite.prepare("SELECT version FROM analysis_jobs WHERE id=?").get(job.id);
  const failed = await f.load("app/api/internal/analysis-jobs/[jobId]/fail/route.ts").POST(f.request("/fail", { workerId: "test-worker", version: current.version, resultKey: "sampling-failed-12345678", errorCode: "SOURCE_INTERNAL_ERROR", errorMessage: "Synthetic interruption", stage: "分析失败", progress: job.progress }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(failed.status, 200);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", {}), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(retried.status, 200);
  assert.equal(f.sqlite.prepare("SELECT visual_sampling_level FROM analysis_jobs WHERE id=?").get(job.id).visual_sampling_level, level);
  const claimed = (await (await f.claim()).json()).job;
  assert.equal(claimed.source.visual_sampling_level, level);
  assert.equal(claimed.checkpoint.visual_sampling_level, level);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(job.id);
  const completed = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(f.request("/complete", { workerId: "test-worker", version: claimed.version, resultKey: "sampling-complete-12345678", analysis: { schemaVersion: "analysis.v1", report: { summary: "Synthetic scheduling-only report", analysis_meta: { visual_sampling_level: level } }, confidence: null } }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(completed.status, 200);
  assert.equal(f.sqlite.prepare("SELECT status FROM analysis_jobs WHERE id=?").get(job.id).status, "completed");
});

test("new default is quick, reanalysis inherits an explicit level, and override starts without an old checkpoint", async t => {
  const f = await fixture(t);
  const original = await (await f.submit()).json(); assert.equal(original.job.visual_sampling_level, "quick"); f.finish(original.job.id);
  const switched = await f.reanalyze(original.video.id, { visualSamplingLevel: "balanced" }); assert.equal(switched.status, 201);
  const quick = await switched.json(); assert.equal(quick.job.visual_sampling_level, "balanced"); f.finish(quick.job.id);
  const inherited = await f.reanalyze(original.video.id); assert.equal(inherited.status, 201);
  const inheritedBody = await inherited.json(); assert.equal(inheritedBody.job.visual_sampling_level, "balanced"); f.finish(inheritedBody.job.id);
  const detailed = await f.reanalyze(original.video.id, { visualSamplingLevel: "detailed" }); assert.equal(detailed.status, 201);
  const body = await detailed.json(); assert.equal(body.job.visual_sampling_level, "detailed");
  assert.equal(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(body.job.id).checkpoint_json, null);
});

test("historical NULL survives retry and claim with an omitted source field, while a new reanalysis selects quick", async t => {
  const f = await fixture(t);
  const original = await (await f.submit()).json();
  const checkpoint = { checkpoint_version: 1, media: {}, transcript: {}, visuals: {} };
  f.sqlite.prepare("UPDATE analysis_jobs SET visual_sampling_level=NULL,status='failed',checkpoint_stage='evidence_ready',checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), original.job.id);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", {}), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal(retried.status, 200);
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.visual_sampling_level, null); assert.equal(Object.hasOwn(job.source, "visual_sampling_level"), false);
  assert.equal(Object.hasOwn(job.checkpoint, "visual_sampling_level"), false); f.finish(job.id);
  const fresh = await f.reanalyze(original.video.id); assert.equal(fresh.status, 201);
  assert.equal((await fresh.json()).job.visual_sampling_level, "quick");
});

test("explicit invalid URL, upload, retry and reanalysis sampling options are rejected", async t => {
  const f = await fixture(t);
  for (const value of [null, false, 1, {}, "legacy", "fast"]) {
    const response = await f.submit({ visualSamplingLevel: value }); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_VISUAL_SAMPLING_LEVEL");
  }
  const original = await (await f.submit()).json(); f.finish(original.job.id);
  assert.equal((await f.reanalyze(original.video.id, { visualSamplingLevel: null })).status, 400);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("visualSamplingLevel", "legacy");
  const uploaded = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(uploaded.status, 400);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", { visualSamplingLevel: "fast" }), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal(retried.status, 400);
});

test("upload and manual transcript reanalysis keep sampling independent of visual mode and preserve corrected text", async t => {
  const f = await fixture(t);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("visualSamplingLevel", "detailed"); form.set("visualAnalysisMode", "vision_only");
  const uploaded = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(uploaded.status, 202); const original = await uploaded.json();
  assert.equal(original.job.visual_sampling_level, "detailed"); assert.equal(original.job.visual_analysis_mode, "vision_only");
  f.finish(original.job.id);
  const saved = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request("/transcript", { ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: "人工确认原文" }], reanalyze: true }), { params: Promise.resolve({ videoId: original.video.id }) });
  assert.equal(saved.status, 201); const body = await saved.json();
  assert.equal(body.job.visual_sampling_level, "detailed"); assert.equal(body.job.visual_analysis_mode, "vision_only");
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.source.visual_sampling_level, "detailed"); assert.equal(job.source.manual_transcript.segments[0].text, "人工确认原文");
});

test("company reuse refuses different sampling and a pending new level cannot relabel an older report", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ visualSamplingLevel: "quick" })).json();
  let mismatch = await f.submit({ projectId: f.otherProjectId, visualSamplingLevel: "detailed" });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "VISUAL_SAMPLING_LEVEL_MISMATCH");
  const reused = await f.submit({ projectId: f.otherProjectId, visualSamplingLevel: "quick" }); assert.equal(reused.status, 200);
  assert.equal((await reused.json()).job.visual_sampling_level, "quick");
  f.sqlite.prepare("DELETE FROM project_video_references").run(); f.finish(original.job.id); const now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,analysis_job_id,schema_version,report_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'analysis.v12','{}',?,?,?)").run(crypto.randomUUID(), f.scope.organizationId, f.projectId, original.video.id, original.job.id, f.identity.userId, now, now);
  assert.equal((await f.reanalyze(original.video.id, { visualSamplingLevel: "detailed" })).status, 201);
  mismatch = await f.submit({ projectId: f.otherProjectId, visualSamplingLevel: "detailed" });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "VISUAL_SAMPLING_LEVEL_MISMATCH");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_video_references").get().n, 0);
});

test("new jobs reject missing, legacy, invalid or changed sampling checkpoints and reports, and retries cannot switch level", async t => {
  const f = await fixture(t); const original = await (await f.submit({ visualSamplingLevel: "quick" })).json();
  const job = (await (await f.claim()).json()).job; f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(job.id);
  for (const value of [undefined, null, "balanced", "future"]) {
    const metadata = value === undefined ? {} : { visual_sampling_level: value };
    const checkpoint = { checkpoint_version: 1, media: {}, transcript: {}, visuals: {}, ...metadata };
    const saved = await f.load("app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts").POST(f.request("/checkpoint", { workerId: "test-worker", version: job.version, attempt: job.attempt_count, stage: "evidence_ready", checkpoint }, true), { params: Promise.resolve({ jobId: job.id }) });
    assert.equal(saved.status, 409); assert.equal((await saved.json()).error.code, "VISUAL_SAMPLING_LEVEL_MISMATCH");
    const completed = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(f.request("/complete", { workerId: "test-worker", version: job.version, resultKey: "sampling-wrong-12345678", analysis: { schemaVersion: "analysis.v1", report: { analysis_meta: metadata }, confidence: null } }, true), { params: Promise.resolve({ jobId: job.id }) });
    assert.equal(completed.status, 409); assert.equal((await completed.json()).error.code, "VISUAL_SAMPLING_LEVEL_MISMATCH");
  }
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(job.id);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", { visualSamplingLevel: "detailed" }), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal(retried.status, 409); assert.equal((await retried.json()).error.code, "VISUAL_SAMPLING_LEVEL_MISMATCH");
});
