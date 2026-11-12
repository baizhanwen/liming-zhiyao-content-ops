import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function simpleFixture(t, options = {}) {
  const f = await ecommerceGenerationFixture(t, options);
  const product = await f.saveProduct({ name: "简化合成杯（非真实商品）", sku: "AUTO-SYNTHETIC-ONLY", status: "confirmed", publicData: { ...f.productInput.publicData, specification: "容量500ml", sellingPoints: "合成杯的用户录入卖点：轻巧易收纳\n具体表述以用户确认资料为准", priceCents: 10000, claims: [] } });
  const videoId = f.seed("videos", { title: "合成带货参考", platform: "douyin", source_type: "url", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ structure: "先问顾虑，再介绍规格，最后引导了解商品。" }) });
  const brief = { ...f.brief, referenceMode: "benchmark", benchmark: { referenceId, analysisId, transcriptId: null }, claimId: "", evidenceIds: [], filming: [] };
  f.sqlite.prepare("UPDATE ecommerce_tasks SET product_id=?,product_version_id=?,brief_json=? WHERE id=?").run(product.id, product.versionId, JSON.stringify(brief), f.task.id);
  return { ...f, simpleProduct: product, simpleBrief: brief };
}

test("a user-confirmed product without manual claims can produce benchmark copy without creating evidence records", async t => {
  const f = await simpleFixture(t);
  const before = f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").get().n;
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const context = f.calls[0].payload.context;
  assert.equal(context.product.versionId, f.simpleProduct.versionId);
  const productList = await (await f.route("products").GET(f.request("GET"))).json();
  const savedProduct = productList.products.find(product => product.id === f.simpleProduct.id);
  const points = "合成杯的用户录入卖点：轻巧易收纳\n具体表述以用户确认资料为准";
  assert.equal(JSON.parse(savedProduct.public_json).sellingPoints, points);
  assert.equal(context.product.sellingPoints, points);
  assert.ok(context.evidence[0].body.includes(points));
  assert.equal(context.cases.some(source => source.text.includes(points)), false, "own selling points must not be attributed to a benchmark");
  assert.equal(context.product.claim.id, `product-claim:${f.simpleProduct.versionId}`);
  assert.equal(context.evidence[0].id, `product-facts:${f.simpleProduct.versionId}`);
  assert.equal(context.evidence[0].virtualProductVersionId, f.simpleProduct.versionId);
  assert.match(context.evidence[0].body, /用户确认的商品资料.*不等同于外部实验或认证/);
  assert.match(context.evidence[0].body, /500ml/);
  assert.match(context.evidence[0].body, /100 CNY/);
  assert.doesNotMatch(context.evidence[0].body, /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS/);
  assert.equal("virtualProductSnapshot" in context, false);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_evidence").get().n, before);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_evidence WHERE product_id=?").get(f.simpleProduct.id).n, 0);
  const pack = (await response.json()).version.pack;
  assert.ok(pack.segments.some(segment => segment.claimIds.includes(context.product.claim.id)));
  assert.ok(pack.segments.some(segment => segment.evidenceIds.includes(context.evidence[0].id)));
  assert.deepEqual(pack.filmingChecklist, []);
});

test("the same confirmed claim-free product can generate by methodology without a benchmark", async t => {
  const f = await simpleFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.simpleBrief, referenceMode: "method", benchmark: null }), f.task.id);
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls[0].payload.context.cases, []);
  assert.match(f.calls[0].payload.context.product.claim.id, /^product-claim:/);
});

test("invented virtual IDs in a task are rejected instead of accepting client-supplied facts", async t => {
  const f = await simpleFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.simpleBrief, claimId: `product-claim:${f.simpleProduct.versionId}`, evidenceIds: [`product-facts:${f.simpleProduct.versionId}`] }), f.task.id);
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "EVIDENCE_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
});

for (const status of ["draft", "revoked"]) test(`simple benchmark refuses a ${status} product before model calls`, async t => {
  const f = await simpleFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_products SET status=? WHERE id=?").run(status, f.simpleProduct.id);
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "PRODUCT_NOT_CONFIRMED");
  assert.equal(f.calls.length, 0);
});

test("simple benchmark refuses a previously confirmed historical product version", async t => {
  const f = await simpleFixture(t);
  await f.saveProduct({ id: f.simpleProduct.id, revision: 1, sku: "AUTO-SYNTHETIC-ONLY", name: "更新后的简化商品", status: "confirmed", publicData: { ...f.productInput.publicData, specification: "新容量600ml", claims: [] } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "PRODUCT_VERSION_CHANGED");
  assert.equal(f.calls.length, 0);
});

for (const change of ["revoked", "revision", "current-version", "selling-points"]) test(`final transaction rejects a late simple-product ${change} change`, async t => {
  const f = await simpleFixture(t), batch = f.db.batch;
  let changed = false;
  f.db.batch = async statements => {
    if (!changed && f.calls.length === 3) {
      changed = true;
      if (change === "revoked") f.sqlite.prepare("UPDATE ecommerce_products SET status='revoked' WHERE id=?").run(f.simpleProduct.id);
      if (change === "revision") f.sqlite.prepare("UPDATE ecommerce_products SET revision=revision+1 WHERE id=?").run(f.simpleProduct.id);
      if (change === "selling-points") {
        const row = f.sqlite.prepare("SELECT * FROM ecommerce_product_versions WHERE id=?").get(f.simpleProduct.versionId);
        const updated = { ...JSON.parse(row.public_json), sellingPoints: "迟到的卖点修改，不应接受旧文案" };
        f.seed("ecommerce_product_versions", { ...row, id: crypto.randomUUID(), version: row.version + 1, public_json: JSON.stringify(updated) });
        f.sqlite.prepare("UPDATE ecommerce_products SET current_version=current_version+1,revision=revision+1 WHERE id=?").run(f.simpleProduct.id);
      }
      if (change === "current-version") f.sqlite.prepare("UPDATE ecommerce_products SET current_version=current_version+1 WHERE id=?").run(f.simpleProduct.id);
    }
    return batch(statements);
  };
  const response = await f.generate();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(changed, true);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks WHERE id=?").get(f.task.id).current_version, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 3);
});

test("benchmark copy can be generated without a space strategy and does not adopt another space's strategy", async t => {
  const f = await simpleFixture(t);
  f.sqlite.prepare("UPDATE content_strategies SET status='draft'").run();
  f.seed("content_strategies", { id: "foreign-only-strategy", project_id: "foreign-project", name: "其他空间策略", version: 1, status: "active", positioning: "其他账号定位", target_audience: "其他账号人群", style_notes: "不应采用", pain_points_json: "[]", topic_mix_json: "{}", cadence: "", conversion_path: "", pillars_json: "[]", persona: "", objectives_json: "[]" });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  for (const call of f.calls) {
    assert.equal(call.payload.context.strategy, null);
    assert.equal("optionalStrategySnapshot" in call.payload.context, false);
    assert.doesNotMatch(JSON.stringify(call.payload.context), /其他账号定位|其他账号人群/);
  }
});

test("an incomplete latest strategy stays optional for benchmark copy", async t => {
  const f = await simpleFixture(t);
  f.sqlite.prepare("UPDATE content_strategies SET positioning='',target_audience='',version=2 WHERE id='commerce-strategy'").run();
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(f.calls[0].payload.context.strategy, null);
});

test("method writing can use task requirements when a strategy has not been configured", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.sqlite.prepare("UPDATE content_strategies SET status='draft'").run();
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(f.calls[0].payload.context.strategy, null);
});

for (const change of ["activate", "complete", "revoke"]) test(`final transaction rejects a late benchmark strategy ${change}`, async t => {
  const f = await simpleFixture(t), batch = f.db.batch;
  if (change === "activate") f.sqlite.prepare("UPDATE content_strategies SET status='draft'").run();
  if (change === "complete") f.sqlite.prepare("UPDATE content_strategies SET target_audience=''").run();
  let changed = false;
  f.db.batch = async statements => {
    if (!changed && f.calls.length === 3) {
      changed = true;
      if (change === "activate") f.sqlite.prepare("UPDATE content_strategies SET status='active' WHERE id='commerce-strategy'").run();
      if (change === "complete") f.sqlite.prepare("UPDATE content_strategies SET target_audience='迟到补齐的人群' WHERE id='commerce-strategy'").run();
      if (change === "revoke") f.sqlite.prepare("UPDATE content_strategies SET status='draft' WHERE id='commerce-strategy'").run();
    }
    return batch(statements);
  };
  const response = await f.generate();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(changed, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 3);
});
