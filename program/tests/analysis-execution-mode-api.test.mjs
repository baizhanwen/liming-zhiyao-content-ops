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


test("execution migration keeps old rows serial and rejects unsupported modes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY); INSERT INTO analysis_jobs VALUES('historical')");
    db.exec(readFileSync(new URL("../drizzle/0055_analysis_execution_mode.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT execution_mode FROM analysis_jobs").get().execution_mode, "serial");
    assert.throws(() => db.exec("INSERT INTO analysis_jobs(id,execution_mode) VALUES('invalid','unbounded')"), /CHECK constraint failed/);
  } finally { db.close(); }
});

for (const mode of ["serial", "controlled_parallel"]) test(`${mode} persists through URL, worker checkpoint, failure, retry and claim`, async t => {
  const f = await fixture(t);
  const submitted = await f.submit({ executionMode: mode });
  assert.equal(submitted.status, 202); const original = await submitted.json();
  assert.equal(original.job.execution_mode, mode);
  assert.equal(f.sqlite.prepare("SELECT execution_mode FROM analysis_jobs WHERE id=?").get(original.job.id).execution_mode, mode);
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.execution_mode, mode); assert.equal(job.source.execution_mode, mode);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(job.id);
  const checkpoint = { checkpoint_version: 1, execution_mode: mode, visual_analysis_mode: "hybrid", visual_sampling_level: "quick", media: {}, transcript: {}, visuals: {} };
  const saved = await f.load("app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts").POST(f.request("/checkpoint", { workerId: "test-worker", version: job.version, attempt: job.attempt_count, stage: "evidence_ready", checkpoint }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(saved.status, 201);
  const failed = await f.load("app/api/internal/analysis-jobs/[jobId]/fail/route.ts").POST(f.request("/fail", { workerId: "test-worker", version: job.version, resultKey: "execution-failed-12345678", errorCode: "SOURCE_INTERNAL_ERROR", errorMessage: "Synthetic interruption", stage: "分析失败", progress: job.progress }, true), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(failed.status, 200);
  const retry = f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST;
  const swapped = await retry(f.request("/retry", { executionMode: mode === "serial" ? "controlled_parallel" : "serial" }), { params: Promise.resolve({ jobId: job.id }) });
  assert.equal(swapped.status, 409); assert.equal((await swapped.json()).error.code, "ANALYSIS_EXECUTION_MODE_MISMATCH");
  const retried = await retry(f.request("/retry", {}), { params: Promise.resolve({ jobId: job.id }) }); assert.equal(retried.status, 200);
  const restored = (await (await f.claim()).json()).job;
  assert.equal(restored.execution_mode, mode); assert.equal(restored.source.execution_mode, mode); assert.equal(restored.checkpoint.execution_mode, mode);
});

test("new URL and upload submissions default to controlled parallel", async t => {
  const f = await fixture(t);
  const original = await (await f.submit()).json(); assert.equal(original.job.execution_mode, "controlled_parallel"); f.finish(original.job.id);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" }));
  const response = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(response.status, 202); const uploaded = await response.json();
  assert.equal(uploaded.job.execution_mode, "controlled_parallel");
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.source.execution_mode, "controlled_parallel");
});

for (const mode of ["serial", "controlled_parallel"]) test(`upload and manual reanalysis preserve ${mode}, and an explicit new task can switch`, async t => {
  const f = await fixture(t);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("executionMode", mode);
  const uploaded = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form }));
  assert.equal(uploaded.status, 202); const original = await uploaded.json(); assert.equal(original.job.execution_mode, mode); f.finish(original.job.id);
  const manual = options => f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request("/transcript", { ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: "人工确认原文" }], reanalyze: true, ...options }), { params: Promise.resolve({ videoId: original.video.id }) });
  const inheritedResponse = await manual({}); assert.equal(inheritedResponse.status, 201); const inherited = await inheritedResponse.json();
  assert.equal(inherited.job.execution_mode, mode); f.finish(inherited.job.id);
  const switchedMode = mode === "serial" ? "controlled_parallel" : "serial";
  const switchedResponse = await manual({ executionMode: switchedMode }); assert.equal(switchedResponse.status, 201); const switched = await switchedResponse.json();
  assert.equal(switched.job.execution_mode, switchedMode);
  const claimed = (await (await f.claim()).json()).job; assert.equal(claimed.source.execution_mode, switchedMode); assert.equal(claimed.source.manual_transcript.segments[0].text, "人工确认原文");
});

test("reanalysis inherits existing scheduling while explicit reanalysis can change it, including transcript-only", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ executionMode: "serial" })).json(); f.finish(original.job.id);
  const inherited = await f.reanalyze(original.video.id); assert.equal(inherited.status, 201); const inheritedBody = await inherited.json();
  assert.equal(inheritedBody.job.execution_mode, "serial"); f.finish(inheritedBody.job.id);
  const changed = await f.reanalyze(original.video.id, { executionMode: "controlled_parallel" }); assert.equal(changed.status, 201); const changedBody = await changed.json();
  assert.equal(changedBody.job.execution_mode, "controlled_parallel");
  assert.equal(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(changedBody.job.id).checkpoint_json, null); f.finish(changedBody.job.id);
  const transcriptOnly = await f.reanalyze(original.video.id, { task: "transcript", executionMode: "serial" }); assert.equal(transcriptOnly.status, 201); const body = await transcriptOnly.json();
  assert.equal(body.job.execution_mode, "serial"); const claimed = (await (await f.claim()).json()).job;
  assert.equal(claimed.source.execution_mode, "serial"); assert.equal(claimed.source.transcript_only, true);
});

test("invalid URL, upload, manual-reanalysis, retry and reanalysis execution modes are rejected", async t => {
  const f = await fixture(t);
  for (const value of [null, false, 1, {}, "parallel", "unbounded"]) {
    const response = await f.submit({ executionMode: value }); assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_ANALYSIS_EXECUTION_MODE");
  }
  const original = await (await f.submit()).json(); f.finish(original.job.id);
  assert.equal((await f.reanalyze(original.video.id, { executionMode: null })).status, 400);
  const form = new FormData(); form.set("file", new File(["media"], "clip.mp4", { type: "video/mp4" })); form.set("executionMode", "unbounded");
  const uploaded = await f.load("app/api/videos/upload/route.ts").POST(new Request("http://localhost/upload", { method: "POST", headers: { "x-organization-id": f.scope.organizationId, "x-project-id": f.projectId }, body: form })); assert.equal(uploaded.status, 400);
  const retried = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", { executionMode: "parallel" }), { params: Promise.resolve({ jobId: original.job.id }) }); assert.equal(retried.status, 400);
  const manual = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request("/transcript", { ...f.scope, executionMode: "parallel", segments: [{ startMs: 0, endMs: 1000, text: "原文" }], reanalyze: true }), { params: Promise.resolve({ videoId: original.video.id }) }); assert.equal(manual.status, 400);
});

test("diagnostics keep actual report scheduling distinct from request and later job settings", async t => {
  const f = await fixture(t), { buildAnalysisDiagnosticExport } = f.load("lib/analysis-diagnostic-export.ts");
  const input = { exportedAt: new Date().toISOString(), ...f.scope, sourceProjectId: f.projectId, video: { id: "synthetic-video" }, analysis: { id: "report", analysis_job_id: "old-job", report: { analysis_meta: { execution_mode: "serial", requested_execution_mode: "controlled_parallel", execution_fallback_reason: "unsupported_visual_adapter" } } }, job: { id: "old-job", execution_mode: "controlled_parallel" }, latestJob: { id: "new-job", execution_mode: "controlled_parallel" }, events: [], eventCount: 0, eventsThrough: new Date().toISOString() };
  input.analysis.report.analysis_meta.visual_extraction = { branch_timing: { transcription_elapsed_ms: 8000, visual_elapsed_ms: 3000, evidence_wall_elapsed_ms: 8500, speech_visual_overlap_ms: 2500 } };
  const current = buildAnalysisDiagnosticExport(input).diagnostics;
  assert.equal(current.executionMode, "serial"); assert.equal(current.requestedExecutionMode, "controlled_parallel"); assert.equal(current.executionFallbackReason, "unsupported_visual_adapter");
  assert.equal(current.jobSnapshot.execution_mode, "controlled_parallel");
  const timings = Object.fromEntries(current.timings.map(row => [row.key, row]));
  assert.equal(timings.speech_visual_wall.elapsedMs, 8500); assert.equal(timings.speech_visual_wall.basis, "wall");
  assert.equal(timings.speech_visual_overlap.elapsedMs, 2500); assert.equal(timings.speech_visual_overlap.basis, "overlap");
  assert.ok(current.notes.some(note => /语音与画面.*不能直接相加/.test(note)));
  input.analysis.report = {}; const historical = buildAnalysisDiagnosticExport(input).diagnostics;
  assert.equal(historical.executionMode, "serial"); assert.equal(historical.requestedExecutionMode, "serial");
  input.analysis = null; const pending = buildAnalysisDiagnosticExport(input).diagnostics;
  assert.equal(pending.executionMode, "controlled_parallel"); assert.equal(pending.requestedExecutionMode, "controlled_parallel");
});

test("company material reuse keeps its original scheduling record without creating another job", async t => {
  const f = await fixture(t); const original = await (await f.submit({ executionMode: "serial" })).json();
  const response = await f.submit({ projectId: f.otherProjectId, executionMode: "controlled_parallel" });
  assert.equal(response.status, 200); const reused = await response.json(); assert.equal(reused.reused, true);
  assert.equal(reused.job.id, original.job.id); assert.equal(reused.job.execution_mode, "serial");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});
