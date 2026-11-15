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
    ...scope, url: "https://www.douyin.com/video/1234567890123456789", ...options,
  }));
  const claim = () => f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(request("/claim", { workerId: "test-worker", leaseSeconds: 300 }, true));
  const finish = id => f.sqlite.prepare("UPDATE analysis_jobs SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(id);
  const reanalyze = (videoId, options = {}) => f.load("app/api/videos/[videoId]/reanalyze/route.ts").POST(request("/reanalyze", { ...scope, ...options }), { params: Promise.resolve({ videoId }) });
  return { ...f, scope, projectId, otherProjectId, submit, claim, finish, reanalyze, request };
}

test("visual-mode migration defaults historical jobs to hybrid and rejects unknown modes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY); INSERT INTO analysis_jobs VALUES('historical')");
    db.exec(readFileSync(new URL("../drizzle/0053_analysis_visual_mode.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT visual_analysis_mode FROM analysis_jobs").get().visual_analysis_mode, "hybrid");
    assert.throws(() => db.exec("INSERT INTO analysis_jobs(id,visual_analysis_mode) VALUES('invalid','other')"), /CHECK constraint failed/);
  } finally { db.close(); }
});

test("URL submission stores both modes and historical default, then delivers them to the worker", async t => {
  const f = await fixture(t);
  for (const [index, mode] of ["hybrid", "vision_only", undefined].entries()) {
    const response = await f.submit({ url: `https://www.douyin.com/video/123456789012345678${index}`, ...(mode ? { visualAnalysisMode: mode } : {}) });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.job.visual_analysis_mode, mode ?? "hybrid");
    const claimed = await f.claim();
    assert.equal(claimed.status, 200);
    const job = (await claimed.json()).job;
    assert.equal(job.visual_analysis_mode, mode ?? "hybrid");
    assert.equal(job.source.visual_analysis_mode, mode ?? "hybrid");
    f.finish(body.job.id);
  }
});

test("invalid visual modes cannot create URL, upload or reanalysis tasks", async t => {
  const f = await fixture(t);
  for (const mode of ["pure", false, null, {}, 1]) {
    const response = await f.submit({ visualAnalysisMode: mode });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_VISUAL_ANALYSIS_MODE");
  }
  const original = await (await f.submit()).json(); f.finish(original.job.id);
  assert.equal((await f.reanalyze(original.video.id, { visualAnalysisMode: "pure" })).status, 400);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("visualAnalysisMode", "pure");
  const response = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(response.status, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("local upload preserves pure visual mode through stored job and worker claim", async t => {
  const f = await fixture(t);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("visualAnalysisMode", "vision_only");
  const response = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(response.status, 202);
  const body = await response.json(); assert.equal(body.job.visual_analysis_mode, "vision_only");
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.source.visual_analysis_mode, "vision_only");
});

test("retry keeps the original mode while explicit reanalysis switches it using a fresh checkpoint", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ visualAnalysisMode: "vision_only" })).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed' WHERE id=?").run(original.job.id);
  const retry = () => f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", {}), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal((await retry()).status, 200);
  assert.equal(f.sqlite.prepare("SELECT visual_analysis_mode FROM analysis_jobs WHERE id=?").get(original.job.id).visual_analysis_mode, "vision_only");
  f.finish(original.job.id);
  const inherited = await f.reanalyze(original.video.id); assert.equal(inherited.status, 201);
  const inheritedBody = await inherited.json(); assert.equal(inheritedBody.job.visual_analysis_mode, "vision_only");
  f.finish(inheritedBody.job.id);
  const override = await f.reanalyze(original.video.id, { visualAnalysisMode: "hybrid" }); assert.equal(override.status, 201);
  const next = await override.json(); assert.equal(next.job.visual_analysis_mode, "hybrid");
  assert.equal(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(next.job.id).checkpoint_json, null);
});

test("manual transcript reanalysis inherits pure visual mode without losing corrected text", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ visualAnalysisMode: "vision_only" })).json(); f.finish(original.job.id);
  const saved = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request("/transcript", { ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: "人工确认原文" }], reanalyze: true }), { params: Promise.resolve({ videoId: original.video.id }) });
  assert.equal(saved.status, 201); const body = await saved.json();
  assert.equal(body.job.visual_analysis_mode, "vision_only");
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.source.visual_analysis_mode, "vision_only");
  assert.equal(job.source.manual_transcript.segments[0].text, "人工确认原文");
});

test("company library cannot reuse a report or pending task under a different visual mode", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ visualAnalysisMode: "hybrid" })).json();
  let mismatch = await f.submit({ projectId: f.otherProjectId, visualAnalysisMode: "vision_only" });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "VISUAL_ANALYSIS_MODE_MISMATCH");
  f.finish(original.job.id); const now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO video_analyses (id,organization_id,project_id,video_id,analysis_job_id,schema_version,report_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'analysis.v12','{}',?,?,?)").run(crypto.randomUUID(), f.scope.organizationId, f.projectId, original.video.id, original.job.id, f.identity.userId, now, now);
  assert.equal((await f.reanalyze(original.video.id, { visualAnalysisMode: "vision_only" })).status, 201);
  mismatch = await f.submit({ projectId: f.otherProjectId, visualAnalysisMode: "vision_only" });
  assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "VISUAL_ANALYSIS_MODE_MISMATCH");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_video_references").get().n, 0);
});

test("pure visual jobs reject hybrid checkpoints, mode-changing retries and hybrid completions", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ visualAnalysisMode: "vision_only" })).json();
  const job = (await (await f.claim()).json()).job;
  const checkpoint = { checkpoint_version: 1, visual_analysis_mode: "hybrid", media: {}, transcript: {}, visuals: {} };
  const result = await f.load("app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts").POST(f.request("/checkpoint", { workerId: "test-worker", version: job.version, attempt: job.attempt_count, stage: "evidence_ready", checkpoint }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(result.status, 409); assert.equal((await result.json()).error.code, "VISUAL_ANALYSIS_MODE_MISMATCH");
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(job.id);
  const completed = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(f.request("/complete", { workerId: "test-worker", version: job.version, resultKey: "test-result-key", analysis: { schemaVersion: "analysis.v12", report: { analysis_meta: { visual_analysis_mode: "hybrid" } }, confidence: null } }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(completed.status, 409); assert.equal((await completed.json()).error.code, "VISUAL_ANALYSIS_MODE_MISMATCH");
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(job.id);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", { visualAnalysisMode: "hybrid" }), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal(retried.status, 409); assert.equal((await retried.json()).error.code, "VISUAL_ANALYSIS_MODE_MISMATCH");
});
