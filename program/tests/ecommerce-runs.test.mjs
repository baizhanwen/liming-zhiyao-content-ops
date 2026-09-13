import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

function control(f, runId, action = "cancel") {
  return f.route("tasks/[taskId]/runs").POST(f.request("POST", { runId, action }), { params: Promise.resolve({ taskId: f.task.id }) });
}

for (const stopAt of ["plan", "review"]) test(`cancel during ${stopAt} holds capacity until the active call settles and discards its result`, async t => {
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await ecommerceGenerationFixture(t, { onCall: async ({ stage }) => { if (stage === stopAt) { entered(); await held; } } });
  const work = f.generate();
  try {
    await started;
    const run = f.sqlite.prepare("SELECT id FROM ecommerce_generation_runs").get();
    const stopped = await control(f, run.id); assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal((await stopped.json()).run.error_code, "RUN_CANCELLED");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE status='started'").get().n, 1);
    assert.equal((await f.generate({ idempotencyKey: "another-run" })).status, 409);
    assert.equal((await control(f, run.id)).status, 200);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='ecommerce.run.cancel'").get().n, 1);
  } finally { release(); }
  assert.equal((await work).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE status='started'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT error_code FROM ecommerce_generation_runs").get().error_code, "RUN_CANCELLED");
  // Explicitly start a new run after settlement, never as a timeout retry.
  assert.equal((await f.generate({ idempotencyKey: "explicit-new-run" })).status, 201);
});

test("cancellation is scoped and remains available with ecommerce disabled", async t => {
  const f = await ecommerceGenerationFixture(t);
  const runId = f.seed("ecommerce_generation_runs", { task_id: f.task.id, idempotency_key: "interrupted", input_hash: "hash", base_version: 0, task_revision: 1, operation: "generate", status: "running" });
  f.identity.allowed = false; assert.equal((await control(f, runId)).status, 403);
  f.identity.allowed = true;
  const otherTask = await f.route("tasks").POST(f.request("POST", { title: "另一任务", productId: f.product.id, productVersionId: f.product.versionId, brief: f.brief }));
  const foreign = f.seed("ecommerce_generation_runs", { task_id: (await otherTask.json()).task.id, idempotency_key: "other", input_hash: "hash", base_version: 0, task_revision: 1, operation: "generate", status: "running" });
  const response = await control(f, foreign);
  assert.equal(response.status, 404);
  f.sqlite.prepare("UPDATE ecommerce_project_settings SET enabled=0").run();
  assert.equal((await control(f, runId)).status, 200);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_generation_runs WHERE id=?").get(foreign).status, "running");
});

test("recovery requires admin, no recent call activity, and preserves call accounting", async t => {
  const f = await ecommerceGenerationFixture(t), old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const runId = f.seed("ecommerce_generation_runs", { task_id: f.task.id, idempotency_key: "orphan", input_hash: "hash", base_version: 0, task_revision: 1, operation: "generate", status: "running", call_count: 1, created_at: old });
  const callId = f.seed("model_calls", { task_type: "ecommerce.plan", provider: "synthetic", model_name: "synthetic", model_profile: "max", prompt_version: "test", status: "started", input_hash: "hash", input_json: JSON.stringify({ runId }), created_at: old });
  f.identity.role = "member"; assert.equal((await control(f, runId, "recover")).status, 403);
  f.identity.role = "admin";
  f.sqlite.prepare("UPDATE model_calls SET created_at=? WHERE id=?").run(new Date().toISOString(), callId);
  assert.equal((await control(f, runId, "recover")).status, 409);
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls WHERE id=?").get(callId).status, "started");
  f.sqlite.prepare("UPDATE model_calls SET created_at=? WHERE id=?").run(old, callId);
  const response = await control(f, runId, "recover"); assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).run.error_code, "RUN_RECOVERED");
  assert.equal(f.sqlite.prepare("SELECT error_code FROM model_calls WHERE id=?").get(callId).error_code, "ECOMMERCE_CALL_RECOVERED");
  assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs WHERE id=?").get(runId).call_count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
  assert.equal((await f.generate()).status, 201);
});

test("recovery and cancellation never invalidate completed versions", async t => {
  const f = await ecommerceGenerationFixture(t); assert.equal((await f.generate()).status, 201);
  const runId = f.sqlite.prepare("SELECT id FROM ecommerce_generation_runs").get().id;
  for (const action of ["recover", "cancel"]) assert.equal((await control(f, runId, action)).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_generation_runs").get().status, "completed");
});
