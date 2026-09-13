import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

test("generation isolates public facts and records immutable script, sources and every model call", async t => {
  const f = await ecommerceGenerationFixture(t), response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json(); assert.equal(body.run.status, "completed");
  assert.deepEqual(f.calls.map(c => c.stage), ["plan", "draft", "review"]);
  const raw = JSON.stringify(f.calls);
  assert.doesNotMatch(raw, /PRIVATE_|FORBIDDEN_|costCents|internal_json|refundReasons|"stock"/);
  assert.match(raw, /日常商品使用演示/);
  const version = f.sqlite.prepare("SELECT * FROM ecommerce_versions").get();
  assert.equal(version.product_version_id, f.product.versionId);
  assert.doesNotMatch(version.input_snapshot_json, /PRIVATE_|internalData/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE status='completed' AND task_type LIKE 'ecommerce.%'").get().n, 3);
  assert.equal(f.sqlite.prepare("SELECT status FROM generation_source_manifests WHERE capability='ecommerce'").get().status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM content_items").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_memory_items").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas").get().n, 0);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("same idempotency key replays success without another model call, different input is rejected", async t => {
  const f = await ecommerceGenerationFixture(t);
  assert.equal((await f.generate()).status, 201);
  const replay = await f.generate(); assert.equal(replay.status, 200); assert.equal(f.calls.length, 3);
  assert.equal((await f.generate({ instructions: "different" })).status, 409);
  assert.equal(f.calls.length, 3); assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 1);
});

test("unknown reference fails deterministic validation even after repair", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ result, stage }) => {
    if (stage === "draft" || stage === "repair") result.segments[1].evidenceIds = ["not-in-context"];
    return result;
  } });
  const response = await f.generate(); assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT status,error_code FROM ecommerce_generation_runs").get().error_code, "DRAFT_REJECTED");
  assert.deepEqual(f.calls.map(c => c.stage), ["plan", "draft", "repair"]);
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 3);
});

test("independent review rejects unsupported claims instead of saving an apparently valid pack", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ result, stage }) => stage === "review" ? { ...result, supported: false, issues: [{ segmentId: "e", reason: "证据不支持该效果" }] } : result });
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
});

test("revoking evidence while the model runs prevents saving a stale factual version", async t => {
  const f = await ecommerceGenerationFixture(t, { onCall: ({ stage, f }) => {
    if (stage === "review") f.sqlite.prepare("UPDATE ecommerce_evidence SET status='revoked',revision=revision+1").run();
  } });
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks").get().current_version, 0);
});

test("disable mid-generation fails safely and preserves the charged call record", async t => {
  const f = await ecommerceGenerationFixture(t, { onCall: ({ stage, f }) => {
    if (stage === "plan") f.sqlite.prepare("UPDATE ecommerce_project_settings SET enabled=0").run();
  } });
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_generation_runs").get().status, "failed");
});

for (const role of ["hook", "evidence", "cta"]) test(`partial ${role} replacement keeps every other segment byte-for-byte`, async t => {
  const f = await ecommerceGenerationFixture(t); assert.equal((await f.generate()).status, 201);
  const original = JSON.parse(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE version=1").get().pack_json);
  const response = await f.generate({ idempotencyKey: `patch-${role}`, baseVersion: 1, replace: role });
  assert.equal(response.status, 201, await response.clone().text());
  const next = JSON.parse(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE version=2").get().pack_json);
  for (let i = 0; i < original.segments.length; i++) {
    if (original.segments[i].role !== role) assert.deepEqual(next.segments[i], original.segments[i]);
    else assert.notEqual(next.segments[i].script, original.segments[i].script);
  }
  const validation = JSON.parse(f.sqlite.prepare("SELECT validation_json FROM ecommerce_versions WHERE version=2").get().validation_json);
  assert.equal(validation.unchangedSegments.length, 2);
});

test("module per-month limit caps recorded calls without generating a new version", async t => {
  const f = await ecommerceGenerationFixture(t); f.sqlite.prepare("UPDATE ecommerce_project_settings SET monthly_call_limit=1").run();
  assert.equal((await f.generate()).status, 409); assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs").get().call_count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM model_calls").get().n, 1);
});

test("running idempotent request is observable without duplicate work; competing task is bounded", async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const f = await ecommerceGenerationFixture(t, { onCall: async ({ stage }) => { if (stage === "plan") { started(); await pending; } } });
  const first = f.generate(); await ready;
  try {
    assert.equal((await f.generate()).status, 202);
    assert.equal((await f.generate({ idempotencyKey: "competing" })).status, 409);
    assert.equal(f.calls.length, 1);
  } finally { release(); }
  assert.equal((await first).status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 1);
});
