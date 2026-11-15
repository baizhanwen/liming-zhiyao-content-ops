import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  const owner = await f.initialize();
  f.identity.userId = owner.userId;
  const projectId = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'active',?,?,?,?)")
    .run(projectId, owner.organizationId, "Synthetic queue", "Synthetic", owner.userId, owner.userId, now, now);
  Object.assign(f.runtime, {
    getProjectAccess: async () => ({ userId: owner.userId, organizationId: owner.organizationId, projectId, organizationRole: "admin", projectRole: null }),
    canWriteProjectAccess: () => true,
    hashInvitationToken: async value => createHash("sha256").update(value).digest("hex"),
  });
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit: 1000, current: 0 }) });
  f.mock("lib/analyzer-readiness.ts", { readAnalyzerReadiness: async () => ({}), analyzerReadinessError: () => null });
  const request = (body, internal = false) => new Request("http://fixture.invalid/local", {
    method: "POST", headers: { "content-type": "application/json", ...(internal ? { authorization: "Bearer synthetic-service-token" } : {}) }, body: JSON.stringify(body),
  });
  for (let index = 0; index < 2; index += 1) {
    const response = await f.load("app/api/videos/from-url/route.ts").POST(request({ organizationId: owner.organizationId, projectId, url: `https://www.douyin.com/video/123456789012345678${index}` }));
    assert.equal(response.status, 202);
  }
  const claim = () => f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(request({ workerId: "synthetic-worker", leaseSeconds: 300 }, true));
  const job = (await (await claim()).json()).job;
  const receipt = { workerId: "synthetic-worker", version: job.version, resultKey: "synthetic-failed-receipt-12345678", errorCode: "SOURCE_INTERNAL_ERROR", errorMessage: "Original collector cleanup error", progress: job.progress, stage: "分析失败" };
  const fail = () => f.load("app/api/internal/analysis-jobs/[jobId]/fail/route.ts").POST(request(receipt, true), { params: Promise.resolve({ jobId: job.id }) });
  const saved = () => f.sqlite.prepare("SELECT status,error_code,error_message,lease_owner,lease_expires_at,version,result_key FROM analysis_jobs WHERE id=?").get(job.id);
  return { ...f, job, receipt, claim, fail, saved };
}

for (const interruptedAfterCommit of [false, true]) {
  test(`failure receipt recovers after interruption ${interruptedAfterCommit ? "after commit" : "before any write"} without waiting for lease expiry`, async t => {
    const f = await fixture(t);
    const original = f.saved();
    const batch = f.db.batch;
    let intercepted = false;
    f.db.batch = async statements => {
      if (!intercepted) {
        intercepted = true;
        if (interruptedAfterCommit) await batch(statements);
        throw new Error("Synthetic failure delivery interrupted");
      }
      return batch(statements);
    };
    const first = await f.fail();
    assert.equal(first.status, 500);
    let nextJob;
    if (interruptedAfterCommit) {
      assert.equal(f.saved().lease_owner, null);
      // A retry of the old receipt must not clear a newer task's lease.
      const next = await f.claim(); assert.equal(next.status, 200);
      nextJob = (await next.json()).job;
    } else {
      assert.deepEqual(f.saved(), original);
      assert.equal((await f.claim()).status, 204);
    }
    const retry = await f.fail();
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).idempotent, interruptedAfterCommit);
    const final = f.saved();
    assert.equal(final.status, "failed");
    assert.equal(final.error_code, "SOURCE_INTERNAL_ERROR");
    assert.equal(final.error_message, f.receipt.errorMessage);
    assert.equal(final.result_key, f.receipt.resultKey);
    assert.equal(final.version, original.version + 1);
    assert.equal(final.lease_owner, null); assert.equal(final.lease_expires_at, null);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_job_events WHERE job_id=? AND event_type='failed'").get(f.job.id).n, 1);
    if (!nextJob) {
      const next = await f.claim(); assert.equal(next.status, 200);
      nextJob = (await next.json()).job;
    }
    assert.notEqual(nextJob.id, f.job.id);
    assert.equal(f.sqlite.prepare("SELECT lease_owner FROM analysis_jobs WHERE id=?").get(nextJob.id).lease_owner, "synthetic-worker");
    assert.equal((await f.claim()).status, 204);
  });
}

test("late failure receipts cannot overwrite a replaced owner, new version or cancellation", async t => {
  for (const mutation of [
    "UPDATE analysis_jobs SET lease_owner='another-worker',version=version+1 WHERE id=?",
    "UPDATE analysis_jobs SET version=version+1 WHERE id=?",
    "UPDATE analysis_jobs SET status='cancelled' WHERE id=?",
  ]) {
    const f = await fixture(t);
    f.sqlite.prepare(mutation).run(f.job.id);
    const current = f.saved();
    const response = await f.fail();
    assert.equal(response.status, 409);
    assert.deepEqual(f.saved(), current);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_job_events WHERE job_id=? AND event_type='failed'").get(f.job.id).n, 0);
  }
});
