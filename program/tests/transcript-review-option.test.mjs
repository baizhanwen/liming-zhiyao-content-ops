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
    getMediaBucket: () => ({ head: async () => null }), getLegacyMediaBucket: () => null,
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

test("transcript-review migration retains historical jobs and restricts boolean values", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY); INSERT INTO analysis_jobs VALUES('historical')");
    db.exec(readFileSync(new URL("../drizzle/0052_analysis_transcript_review.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("SELECT transcript_review_enabled FROM analysis_jobs").get().transcript_review_enabled, 1);
    assert.throws(() => db.exec("INSERT INTO analysis_jobs(id,transcript_review_enabled) VALUES('invalid',2)"), /CHECK constraint failed/);
  } finally { db.close(); }
});

test("URL submissions persist explicit false, true and legacy default and claims deliver booleans", async t => {
  const f = await fixture(t);
  for (const [index, option] of [false, true, undefined].entries()) {
    const response = await f.submit({ url: `https://www.douyin.com/video/123456789012345678${index}`, ...(option === undefined ? {} : { transcriptReviewEnabled: option }) });
    assert.equal(response.status, 202);
    const created = await response.json();
    assert.equal(created.job.transcript_review_enabled, option !== false);
    assert.equal(f.sqlite.prepare("SELECT transcript_review_enabled FROM analysis_jobs WHERE id=?").get(created.job.id).transcript_review_enabled, option === false ? 0 : 1);
    const claimed = await f.claim();
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).job.source.transcript_review_enabled, option !== false);
    f.finish(created.job.id);
  }
});

test("URL and reanalysis APIs reject non-boolean review values before creating jobs", async t => {
  const f = await fixture(t);
  for (const value of ["false", 0, null, {}]) {
    const response = await f.submit({ transcriptReviewEnabled: value });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_TRANSCRIPT_REVIEW_OPTION");
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 0);
  const created = await (await f.submit({ transcriptReviewEnabled: false })).json();
  f.finish(created.job.id);
  assert.equal((await f.reanalyze(created.video.id, { transcriptReviewEnabled: "false" })).status, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("cross-project reuse requires the same review option and does not create references on mismatch", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ transcriptReviewEnabled: false })).json();
  const mismatch = await f.submit({ projectId: f.otherProjectId, transcriptReviewEnabled: true });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "TRANSCRIPT_REVIEW_OPTION_MISMATCH");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_video_references").get().n, 0);
  const reused = await f.submit({ projectId: f.otherProjectId, transcriptReviewEnabled: false });
  assert.equal(reused.status, 200);
  const body = await reused.json();
  assert.equal(body.reused, true);
  assert.equal(body.job.id, original.job.id);
  assert.equal(body.job.transcript_review_enabled, false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
});

test("a new pending review choice cannot silently reuse an older report made with another choice", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ transcriptReviewEnabled: true })).json();
  f.finish(original.job.id);
  const now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO video_analyses (id,organization_id,project_id,video_id,analysis_job_id,schema_version,report_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'analysis.v12','{}',?,?,?)")
    .run(crypto.randomUUID(), f.scope.organizationId, f.projectId, original.video.id, original.job.id, f.identity.userId, now, now);
  const next = await f.reanalyze(original.video.id, { transcriptReviewEnabled: false });
  assert.equal(next.status, 201);
  const reuse = await f.submit({ projectId: f.otherProjectId, transcriptReviewEnabled: false });
  assert.equal(reuse.status, 409);
  assert.equal((await reuse.json()).error.code, "TRANSCRIPT_REVIEW_OPTION_MISMATCH");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_video_references").get().n, 0);
});

test("retry retains review choice while reanalysis inherits it and permits an explicit override", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ transcriptReviewEnabled: false })).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed' WHERE id=?").run(original.job.id);
  const retry = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request("/retry", {}), { params: Promise.resolve({ jobId: original.job.id }) });
  assert.equal(retry.status, 200);
  assert.equal(f.sqlite.prepare("SELECT transcript_review_enabled FROM analysis_jobs WHERE id=?").get(original.job.id).transcript_review_enabled, 0);
  f.finish(original.job.id);
  const inherited = await f.reanalyze(original.video.id);
  assert.equal(inherited.status, 201);
  const inheritedBody = await inherited.json();
  assert.equal(inheritedBody.job.transcript_review_enabled, false);
  f.finish(inheritedBody.job.id);
  const overridden = await f.reanalyze(original.video.id, { transcriptReviewEnabled: true });
  assert.equal(overridden.status, 201);
  assert.equal((await overridden.json()).job.transcript_review_enabled, true);
});

test("manual reanalysis preserves corrected text and inherits disabled AI review through claim", async t => {
  const f = await fixture(t);
  const original = await (await f.submit({ transcriptReviewEnabled: false })).json();
  f.finish(original.job.id);
  const correctedText = "人工确认的版本号与专有名称";
  const saved = await f.load("app/api/videos/[videoId]/transcript/route.ts").POST(f.request("/transcript", {
    ...f.scope, segments: [{ startMs: 0, endMs: 1000, text: correctedText }], reanalyze: true,
  }), { params: Promise.resolve({ videoId: original.video.id }) });
  assert.equal(saved.status, 201);
  const body = await saved.json();
  assert.equal(body.job.transcript_review_enabled, false);
  assert.equal(f.sqlite.prepare("SELECT input_transcript_id FROM analysis_jobs WHERE id=?").get(body.job.id).input_transcript_id, body.transcript.id);
  const claimed = await f.claim();
  assert.equal(claimed.status, 200);
  const job = (await claimed.json()).job;
  assert.equal(job.source.transcript_review_enabled, false);
  assert.equal(job.source.manual_transcript.id, body.transcript.id);
  assert.equal(job.source.manual_transcript.segments[0].text, correctedText);
  f.finish(body.job.id);
  const reanalysis = await f.reanalyze(original.video.id);
  const reanalysisBody = await reanalysis.json();
  assert.equal(reanalysis.status, 201);
  assert.equal(f.sqlite.prepare("SELECT input_transcript_id FROM analysis_jobs WHERE id=?").get(reanalysisBody.job.id).input_transcript_id, body.transcript.id);
});
