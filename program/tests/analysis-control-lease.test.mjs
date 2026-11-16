import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-control-service" } });
  const owner = await f.initialize(), now = new Date().toISOString(), leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const projectId = crypto.randomUUID(), videoId = crypto.randomUUID(), jobId = crypto.randomUUID(), url = "https://www.douyin.com/video/1234567890123456789";
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(projectId, owner.organizationId, "Synthetic control", "Synthetic", owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,?,?,?,?)")
    .run(videoId, owner.organizationId, projectId, url, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,progress,lease_owner,lease_expires_at,attempt_count,version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'url',?,?,'processing',22,'control-worker',?,2,7,?,?,?,?)")
    .run(jobId, owner.organizationId, projectId, videoId, url, `control:${jobId}`, leaseExpiresAt, owner.userId, owner.userId, now, now);
  const headers = { authorization: "Bearer synthetic-control-service", "x-worker-id": "control-worker", "x-worker-attempt": "2" };
  const control = (overrides = {}) => f.load("app/api/internal/analysis-jobs/[jobId]/control/route.ts").GET(new Request("http://localhost/control", { headers: { ...headers, ...overrides } }), { params: Promise.resolve({ jobId }) });
  return { ...f, jobId, leaseExpiresAt, control, headers };
}

test("control returns the confirmed expiry and attempt without extending or mutating the lease", async t => {
  const f = await fixture(t), before = f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId);
  const response = await f.control(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "processing", version: 7, progress: 22, leaseExpiresAt: f.leaseExpiresAt, attempt: 2 });
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), before);
});

for (const [name, change] of [
  ["cancelled", "status='cancelled'"], ["completed", "status='completed'"],
  ["replacement owner", "lease_owner='another-worker'"], ["replacement attempt", "attempt_count=3"],
  ["expired", "lease_expires_at='2000-01-01T00:00:00.000Z'"], ["missing lease", "lease_expires_at=NULL"],
]) test(`control never confirms lease metadata after ${name}`, async t => {
  const f = await fixture(t); f.sqlite.exec(`UPDATE analysis_jobs SET ${change}`);
  const response = await f.control(); assert.equal(response.status, 409); const body = await response.json();
  assert.equal(body.error.code, "JOB_EXECUTION_REVOKED"); assert.equal(Object.hasOwn(body, "leaseExpiresAt"), false); assert.equal(Object.hasOwn(body, "attempt"), false);
});

test("unknown jobs and unauthorized requests cannot obtain a confirmed lease", async t => {
  const f = await fixture(t);
  for (const overrides of [{ authorization: "Bearer invalid" }, { "x-worker-id": "other-worker" }, { "x-worker-attempt": "1" }]) {
    const response = await f.control(overrides); assert.ok([401, 409].includes(response.status));
    const body = await response.json(); assert.equal(Object.hasOwn(body, "leaseExpiresAt"), false); assert.equal(Object.hasOwn(body, "attempt"), false);
  }
  f.sqlite.prepare("DELETE FROM analysis_jobs WHERE id=?").run(f.jobId);
  const response = await f.control(); assert.equal(response.status, 404); assert.equal(Object.hasOwn(await response.json(), "leaseExpiresAt"), false);
});

test("claim snake-case expiry and heartbeat camel-case expiry agree with subsequent control confirmation", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(f.jobId);
  const internal = (name, payload, context) => f.load(`app/api/internal/analysis-jobs/${name}/route.ts`).POST(new Request("http://localhost/internal", {
    method: "POST", headers: { authorization: f.headers.authorization, "content-type": "application/json" }, body: JSON.stringify(payload),
  }), context);
  const claimedResponse = await internal("claim", { workerId: "control-worker", leaseSeconds: 60 }); assert.equal(claimedResponse.status, 200);
  const claimed = (await claimedResponse.json()).job; assert.equal(typeof claimed.lease_expires_at, "string"); assert.equal(claimed.attempt_count, 3);
  const heartbeatResponse = await internal("[jobId]/heartbeat", { workerId: "control-worker", version: claimed.version, status: claimed.status, progress: claimed.progress, stage: "Synthetic heartbeat", leaseSeconds: 60 }, { params: Promise.resolve({ jobId: f.jobId }) });
  assert.equal(heartbeatResponse.status, 200); const heartbeat = (await heartbeatResponse.json()).job; assert.equal(typeof heartbeat.leaseExpiresAt, "string");
  const controlResponse = await f.control({ "x-worker-attempt": String(claimed.attempt_count) }); assert.equal(controlResponse.status, 200);
  const control = await controlResponse.json(); assert.equal(control.leaseExpiresAt, heartbeat.leaseExpiresAt); assert.equal(control.attempt, claimed.attempt_count); assert.equal(control.version, heartbeat.version);
});
