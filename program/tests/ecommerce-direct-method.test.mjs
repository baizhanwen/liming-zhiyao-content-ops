import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

// Uses API-created product/task records and an explicitly synthetic model.
// These tests verify the generation contract, not real-model writing quality.
async function directFixture(t, options = {}) {
  const f = await ecommerceGenerationFixture(t, options);
  const product = await f.saveProduct({
    name: "直接生成合成杯（非真实商品）", sku: "DIRECT-METHOD-SYNTHETIC", status: "confirmed",
    publicData: { ...f.productInput.publicData, specification: "容量500ml", sellingPoints: "用户录入的表达重点：便于收纳", claims: [] },
  });
  f.sqlite.prepare("DELETE FROM ecommerce_component_versions").run();
  f.sqlite.prepare("DELETE FROM ecommerce_components").run();
  f.sqlite.prepare("UPDATE content_strategies SET status='draft'").run();
  const brief = {
    ...f.brief, referenceMode: "method", benchmark: null, caseIds: [], claimId: "", evidenceIds: [], componentIds: [], filming: [],
    scene: "办公桌日常喝水", barrier: "不清楚容量是否符合日常需要", instructions: "只讲容量和使用场景，避免空泛口号。",
  };
  const response = await f.route("tasks").POST(f.request("POST", {
    title: "按方法论直接生成完整文案", productId: product.id, productVersionId: product.versionId, brief,
  }));
  assert.equal(response.status, 201, await response.clone().text());
  const task = (await response.json()).task;
  const generate = (overrides = {}) => f.route("tasks/[taskId]/generate").POST(f.request("POST", {
    revision: 1, baseVersion: 0, idempotencyKey: "direct-method-run", ...overrides,
  }), { params: Promise.resolve({ taskId: task.id }) });
  return { ...f, directProduct: product, directTask: task, directBrief: brief, generate };
}

test("an API-created method task produces a complete draft without a reference, cards, strategy or manual claims", async t => {
  const f = await directFixture(t);
  const evidenceCount = f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").get().n;
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review"]);
  for (const call of f.calls) {
    const { context, generationGuide } = call.payload;
    assert.equal(context.task.brief.referenceMode, "method");
    assert.equal(context.task.id, f.directTask.id);
    assert.equal(context.strategy, null);
    assert.deepEqual(context.cases, []);
    assert.deepEqual(context.candidates, []);
    assert.deepEqual(context.task.brief.caseIds, []);
    assert.equal(generationGuide.copyMethodology.structureAuthority.source, "builtin_methodology");
    assert.equal(context.evidence[0].kind, "manual_confirmation");
    assert.equal(context.evidence[0].virtualProductVersionId, f.directProduct.versionId);
    assert.doesNotMatch(JSON.stringify(call.payload), /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS|FORBIDDEN_/);
  }
  const pack = (await response.json()).version.pack;
  assert.equal(pack.segments[0].role, "hook");
  assert.ok(pack.segments.some(segment => segment.role === "evidence"));
  assert.equal(pack.segments.at(-1).role, "cta");
  assert.ok(pack.segments.every(segment => !segment.componentIds.length && !segment.caseIds.length));
  assert.deepEqual(pack.filmingChecklist, []);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").get().n, evidenceCount);
  const row = f.sqlite.prepare("SELECT * FROM ecommerce_versions WHERE task_id=?").get(f.directTask.id);
  const snapshot = JSON.parse(row.input_snapshot_json), validation = JSON.parse(row.validation_json);
  assert.deepEqual(snapshot.plan.choices, []);
  assert.ok(snapshot.plan.copyDirection.hook);
  assert.equal(snapshot.plan.copyDirection.referenceAdaptation, "");
  assert.ok(snapshot.copyMethodology.version);
  assert.ok(snapshot.copyMethodology.sources.length);
  assert.equal(validation.review.qualityChecks.hookFulfilled, true);
  assert.equal(row.prompt_version, "ecommerce-copy.v6");
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("direct generation never auto-loads other videos, cases or another space's strategy", async t => {
  const f = await directFixture(t);
  const marker = "UNSELECTED_BENCHMARK_FACTS_99999";
  const videoId = f.seed("videos", { title: marker, platform: "douyin", source_type: "url", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ structure: marker }) });
  f.seed("content_strategies", { id: "foreign-direct-strategy", project_id: "foreign-project", name: marker, version: 1, status: "active", positioning: marker, target_audience: marker, style_notes: marker, pain_points_json: "[]", topic_mix_json: "{}", cadence: "", conversion_path: "", pillars_json: "[]", persona: "", objectives_json: "[]" });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(f.calls.every(call => !JSON.stringify(call.payload).includes(marker)));
  assert.ok(f.calls.every(call => !call.payload.context.sources.some(source => source.type === "case")));
});

for (const status of ["draft", "revoked"]) test(`direct generation rejects a ${status} product before model calls`, async t => {
  const f = await directFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_products SET status=? WHERE id=?").run(status, f.directProduct.id);
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "PRODUCT_NOT_CONFIRMED");
  assert.equal(f.calls.length, 0);
});

test("direct generation keeps product-version guards in the final persistence transaction", async t => {
  const f = await directFixture(t), batch = f.db.batch;
  let changed = false;
  f.db.batch = async statements => {
    if (!changed && f.calls.length === 3) {
      changed = true;
      f.sqlite.prepare("UPDATE ecommerce_products SET revision=revision+1 WHERE id=?").run(f.directProduct.id);
    }
    return batch(statements);
  };
  const response = await f.generate();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(changed, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.directTask.id).n, 0);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks WHERE id=?").get(f.directTask.id).current_version, 0);
});

test("a failed semantic review gets one targeted repair and a fresh review within five calls", async t => {
  let reviews = 0;
  const f = await directFixture(t, { respond: ({ stage, result }) => {
    if (stage === "review" && ++reviews === 1) {
      result.qualityChecks.hookFulfilled = false;
      result.issues = [{ segmentId: "h", reason: "开头提出的问题没有在正文中回答，请围绕容量信息重写承接。" }];
    }
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review", "repair", "review"]);
  const repair = f.calls.find(call => call.stage === "repair").payload;
  assert.match(repair.errors.join("；"), /没有在正文中回答|未兑现/);
  assert.equal(repair.generationGuide.copyMethodology.structureAuthority.source, "builtin_methodology");
  assert.equal(f.sqlite.prepare("SELECT call_count FROM ecommerce_generation_runs WHERE task_id=?").get(f.directTask.id).call_count, 5);
  const validation = JSON.parse(f.sqlite.prepare("SELECT validation_json FROM ecommerce_versions WHERE task_id=?").get(f.directTask.id).validation_json);
  assert.equal(validation.review.qualityChecks.hookFulfilled, true);
});

test("a persistent semantic defect is rejected after one repair without saving a draft", async t => {
  const f = await directFixture(t, { respond: ({ stage, result }) => {
    if (stage === "review") result.qualityChecks.singleFocus = false;
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "REVIEW_REJECTED");
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review", "repair", "review"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.directTask.id).n, 0);
});

test("direct drafts support a CTA-only replacement without changing other paragraphs", async t => {
  const f = await directFixture(t);
  const originalResponse = await f.generate();
  assert.equal(originalResponse.status, 201, await originalResponse.clone().text());
  const original = (await originalResponse.json()).version.pack;
  const patchedResponse = await f.generate({ baseVersion: 1, idempotencyKey: "direct-cta-patch", replace: "cta" });
  assert.equal(patchedResponse.status, 201, await patchedResponse.clone().text());
  const patched = (await patchedResponse.json()).version.pack;
  for (let index = 0; index < original.segments.length; index++) {
    if (original.segments[index].role === "cta") assert.notEqual(patched.segments[index].script, original.segments[index].script);
    else assert.deepEqual(patched.segments[index], original.segments[index]);
  }
  assert.deepEqual(f.calls.slice(3).map(call => call.stage), ["patch", "review"]);
});

async function approvedDirectFixture(t) {
  const f = await directFixture(t), generated = await f.generate();
  assert.equal(generated.status, 201, await generated.clone().text());
  const versionId = (await generated.json()).version.id;
  const params = { params: Promise.resolve({ taskId: f.directTask.id }) };
  const review = (action, confirmations = []) => f.route("tasks/[taskId]/review").POST(f.request("POST", {
    revision: 1, versionId, action, confirmations,
  }), params);
  const submitted = await review("submit");
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const approved = await review("approve", ["facts", "destination"]);
  assert.equal(approved.status, 200, await approved.clone().text());
  const accountId = f.seed("social_accounts", { platform: "douyin", account_type: "owned", display_name: "方法论合成发布账号" });
  const publish = () => f.route("tasks/[taskId]/publications").POST(f.request("POST", {
    versionId, accountId, platform: "douyin", externalUrl: "https://example.invalid/direct-method-synthetic-video",
    publishedAt: new Date(Date.now() - 60000).toISOString(), traffic: "organic",
  }), params);
  return { ...f, versionId, accountId, publish };
}

test("a claim-free direct draft can be submitted, approved and registered as published without optional setup", async t => {
  const f = await approvedDirectFixture(t);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_tasks WHERE id=?").get(f.directTask.id).status, "publish_ready");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_components").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_strategies WHERE status='active'").get().n, 0);
  const response = await f.publish();
  assert.equal(response.status, 201, await response.clone().text());
  const publication = (await response.json()).publication;
  const row = f.sqlite.prepare("SELECT * FROM ecommerce_publications WHERE id=?").get(publication.id);
  assert.equal(row.task_id, f.directTask.id);
  assert.equal(row.version_id, f.versionId);
  assert.equal(row.account_id, f.accountId);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_tasks WHERE id=?").get(f.directTask.id).status, "published");
  assert.equal(f.calls.length, 3, "review and registration do not trigger new model requests");
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("direct publication registration rejects a product change after its final JavaScript validation", async t => {
  const f = await approvedDirectFixture(t), batch = f.db.batch;
  let changed = false;
  f.db.batch = async statements => {
    if (!changed) {
      changed = true;
      f.sqlite.prepare("UPDATE ecommerce_products SET revision=revision+1 WHERE id=?").run(f.directProduct.id);
    }
    return batch(statements);
  };
  const response = await f.publish();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(changed, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_publications WHERE task_id=?").get(f.directTask.id).n, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_tasks WHERE id=?").get(f.directTask.id).status, "publish_ready");
});
