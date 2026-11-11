import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

test("only uncapped MCP vision accepts the internal unknown-cap sentinel and usage remains nullable", async t => {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  const owner = await f.initialize(), now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES('calls-project',?,'Synthetic','Synthetic',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,created_by,updated_by,created_at,updated_at) VALUES('calls-video',?,'calls-project','upload','upload',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, now, now);
  f.sqlite.prepare(`INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,lease_owner,lease_expires_at,attempt_count,created_by,updated_by,created_at,updated_at)
    VALUES('calls-job',?,'calls-project','calls-video','upload','source','unified-calls-job','analyzing','calls-worker',?,1,?,?,?,?)`).run(owner.organizationId, new Date(Date.now() + 60_000).toISOString(), owner.userId, owner.userId, now, now);
  const route = f.load("app/api/internal/analysis-jobs/[jobId]/model-calls/route.ts");
  const record = changes => route.POST(new Request("http://localhost/calls", { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify({ id: "call:vision-uncapped-0001", workerId: "calls-worker", task: "vision_batch", status: "started", attempt: 1, outputBudget: 0, inputTokens: null, outputTokens: null, totalTokens: null, ...changes }) }), { params: Promise.resolve({ jobId: "calls-job" }) });
  assert.equal((await record({ task: "report" })).status, 400);
  assert.equal((await record({ task: "canonical_transcript" })).status, 400);
  assert.equal((await record({ outputBudget: -1 })).status, 400);
  assert.equal((await record({ workerId: "wrong-worker" })).status, 409);
  assert.equal((await record({})).status, 200);
  assert.equal((await record({ status: "completed" })).status, 200);
  const stored = f.sqlite.prepare("SELECT output_budget,input_tokens,output_tokens,total_tokens FROM analysis_model_calls").get();
  assert.deepEqual({ ...stored }, { output_budget: 0, input_tokens: null, output_tokens: null, total_tokens: null });
  assert.equal((await record({ id: "call:canonical-0000001", task: "canonical_transcript", outputBudget: 1200 })).status, 200);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='cancelled'").run();
  assert.equal((await record({ id: "call:revoked-vision-0001", outputBudget: 4800 })).status, 409);
});
