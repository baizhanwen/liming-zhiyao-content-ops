import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceFixture } from "./helpers/ecommerce-fixture.mjs";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function readGuide(f, productId) {
  const url = new URL(f.request("GET", {}, "first-video-guide").url);
  if (productId !== undefined) url.searchParams.set("productId", productId);
  return f.route("first-video-guide").GET(new Request(url));
}
const readiness = f => f.load("lib/ecommerce/first-video-guide.ts").deriveFirstVideoReadiness;

test("unknown guide reads cannot claim any completed step", async t => {
  const f = await ecommerceFixture(t), derive = readiness(f);
  for (const value of [undefined, null]) {
    const result = derive(value);
    assert.equal(result.state, "unknown");
    assert.equal(result.completed, false);
    assert.ok(result.steps.every(step => step.status === "unknown"));
  }
});

test("fresh spaces expose real setup requirements without enabling or creating anything", async t => {
  const f = await ecommerceFixture(t);
  const before = f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n;
  const response = await readGuide(f); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.settings.enabled, 0); assert.equal(body.canManage, true);
  assert.equal(body.selectedProduct, null); assert.deepEqual(body.products, []); assert.deepEqual(body.tasks, []);
  assert.equal(body.strategy.ready, false); assert.equal(body.methods.ready, false);
  assert.deepEqual(body.methods.counts, { hook: 0, visual: 0, structure: 0, sop: 0 });
  assert.equal(readiness(f)(body).suggestedStep, "product");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_project_settings").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n, before);
});

test("saved drafts expose public fields and concrete missing steps without private commercial data", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const product = await f.saveProduct();
  const body = await (await readGuide(f, product.id)).json();
  assert.equal(body.selectedProduct.id, product.id);
  assert.equal(body.selectedProduct.ready, false);
  assert.ok(body.selectedProduct.problems.some(message => message.includes("证据")));
  assert.ok(body.selectedProduct.problems.some(message => message.includes("确认当前商品版本")));
  assert.equal(body.selectedProduct.publicData.category, f.productInput.publicData.category);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|costCents|internal_json|marginNotes|refundReasons|"stock"/);
  const view = readiness(f)(body);
  assert.equal(view.productSaved, true); assert.equal(view.productReady, false);
  assert.equal(view.suggestedStep, "evidence");
});

test("a confirmed product needs valid backing evidence; an existing task status is not a generated draft", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET status='publish_ready' WHERE id=?").run(f.task.id);
  const body = await (await readGuide(f)).json();
  assert.equal(body.selectedProduct.id, f.product.id);
  assert.equal(body.selectedProduct.ready, true);
  assert.deepEqual(body.selectedProduct.readyClaimIds, ["rotation"]);
  assert.equal(body.selectedProduct.readyEvidenceCount, 1);
  assert.equal(body.strategy.ready, true); assert.equal(body.methods.ready, true);
  assert.equal(body.tasks[0].hasDraft, false); assert.equal(body.tasks[0].pendingConfirmationCount, null);
  const view = readiness(f)(body);
  assert.equal(view.setupReady, true); assert.equal(view.suggestedStep, "create");
  assert.equal(view.completed, false);
});

test("explicit new-product selection stays empty even when ready products and drafts exist", async t => {
  const f = await ecommerceGenerationFixture(t);
  assert.equal((await f.generate()).status, 201);
  const body = await (await readGuide(f, "")).json();
  assert.equal(body.selectedProductId, null); assert.equal(body.selectedProduct, null);
  assert.equal(body.products.length, 1); assert.equal(body.tasks[0].hasDraft, true);
  assert.equal(readiness(f)(body).suggestedStep, "product");
  assert.equal(readiness(f)(body).completed, false);
});

test("guide reflects current saved draft facts and refreshes never advance business timestamps or model calls", async t => {
  const f = await ecommerceGenerationFixture(t);
  assert.equal((await f.generate()).status, 201);
  const stored = () => JSON.stringify({
    products: f.sqlite.prepare("SELECT id,revision,current_version,updated_at FROM ecommerce_products").all(),
    tasks: f.sqlite.prepare("SELECT id,revision,current_version,updated_at FROM ecommerce_tasks").all(),
    versions: f.sqlite.prepare("SELECT id,pack_json,created_at FROM ecommerce_versions").all(),
    audit: f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get(),
  });
  const before = stored(), calls = f.calls.length;
  for (let count = 0; count < 2; count++) {
    const body = await (await readGuide(f, f.product.id)).json();
    assert.equal(body.tasks[0].hasDraft, true); assert.equal(body.tasks[0].readyForFilming, true);
    assert.equal(body.tasks[0].pendingConfirmationCount, 0);
    assert.equal(readiness(f)(body).completed, true);
    assert.doesNotMatch(JSON.stringify(body), /pack_json|input_snapshot_json|PRIVATE_|internal_json/);
  }
  assert.equal(stored(), before); assert.equal(f.calls.length, calls);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET revision=revision+1 WHERE id=?").run(f.task.id);
  const body = await (await readGuide(f, f.product.id)).json();
  assert.equal(body.tasks[0].hasDraft, false, "a draft for old task conditions cannot complete the current step");
});

test("a real saved pack with pending confirmations is shown as a draft requiring review", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result }) => stage === "draft" ? { ...result, pendingConfirmations: ["人工核实一项事实"] } : result });
  assert.equal((await f.generate()).status, 201);
  const body = await (await readGuide(f, f.product.id)).json();
  assert.equal(body.tasks[0].hasDraft, true); assert.equal(body.tasks[0].readyForFilming, false);
  assert.equal(body.tasks[0].pendingConfirmationCount, 1); assert.equal(readiness(f)(body).completed, false);
});

test("stored drafts remain distinguishable from current preparation after facts or setup are withdrawn", async t => {
  const f = await ecommerceGenerationFixture(t);
  assert.equal((await f.generate()).status, 201);
  f.sqlite.prepare("UPDATE ecommerce_evidence SET status='revoked' WHERE id=?").run(f.evidenceId);
  let body = await (await readGuide(f, f.product.id)).json();
  assert.equal(body.tasks[0].hasDraft, true);
  assert.equal(readiness(f)(body).draftReady, true);
  assert.equal(readiness(f)(body).completed, false);
  f.sqlite.prepare("UPDATE ecommerce_evidence SET status='confirmed' WHERE id=?").run(f.evidenceId);
  f.sqlite.prepare("UPDATE ecommerce_project_settings SET enabled=0").run();
  body = await (await readGuide(f, f.product.id)).json();
  assert.equal(readiness(f)(body).draftReady, true);
  assert.equal(readiness(f)(body).completed, false);
});

test("expired or revoked evidence and product versions stop reporting ready", async t => {
  const f = await ecommerceGenerationFixture(t);
  for (const change of ["status='revoked'", "status='confirmed',valid_until='2000-01-01T00:00:00.000Z'"]) {
    f.sqlite.prepare(`UPDATE ecommerce_evidence SET ${change} WHERE id=?`).run(f.evidenceId);
    const body = await (await readGuide(f, f.product.id)).json();
    assert.equal(body.selectedProduct.ready, false);
    assert.equal(body.selectedProduct.readyEvidenceCount, 0);
    assert.deepEqual(body.selectedProduct.readyClaimIds, []);
  }
  f.sqlite.prepare("UPDATE ecommerce_evidence SET status='confirmed',valid_until=NULL WHERE id=?").run(f.evidenceId);
  f.sqlite.prepare("UPDATE ecommerce_products SET status='revoked' WHERE id=?").run(f.product.id);
  const body = await (await readGuide(f, f.product.id)).json();
  assert.equal(body.selectedProduct.ready, false);
  assert.ok(body.selectedProduct.problems.some(message => message.includes("商品已撤回")));
});

test("expired methods and incomplete active strategies remain visible as missing setup", async t => {
  const f = await ecommerceGenerationFixture(t);
  const now = Date.now(), validUntil = new Date(now + 60_000).toISOString();
  const card = JSON.parse(f.sqlite.prepare("SELECT body_json FROM ecommerce_component_versions WHERE component_id=?").get(f.componentIds[0]).body_json);
  assert.equal((await f.route("components").POST(f.request("POST", { ...card, id: f.componentIds[0], revision: 1, validUntil }))).status, 200);
  f.sqlite.prepare("UPDATE content_strategies SET target_audience='  ' WHERE id='commerce-strategy'").run();
  t.mock.method(Date, "now", () => now + 120_000);
  const body = await (await readGuide(f)).json();
  assert.equal(body.methods.counts.hook, 0); assert.equal(body.methods.ready, false);
  assert.equal(body.strategy.ready, false); assert.equal(readiness(f)(body).setupReady, false);
});

test("an invalid legacy pack stays incomplete without breaking the guide read", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.seed("ecommerce_versions", {
    task_id: f.task.id, product_id: f.product.id, product_version_id: f.product.versionId, version: 1, mode: "manual",
    pack_json: JSON.stringify({ title: "合成旧数据", segments: ["invalid", "legacy"], filmingChecklist: ["准备商品"], applications: [], pendingConfirmations: [] }),
    input_snapshot_json: '{"taskRevision":1}', input_hash: "synthetic", source_manifest_json: "{}", validation_json: '{"ok":true}', change_summary: "合成旧数据",
  });
  f.sqlite.prepare("UPDATE ecommerce_tasks SET current_version=1 WHERE id=?").run(f.task.id);
  const response = await readGuide(f, f.product.id); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tasks[0].hasDraft, false); assert.equal(readiness(f)(body).completed, false);
});

test("foreign products and inaccessible projects are rejected without revealing their records", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const product = f.seed("ecommerce_products", { project_id: "foreign-project", sku: "FOREIGN-SKU", name: "Foreign product" });
  f.seed("ecommerce_product_versions", { product_id: product, project_id: "foreign-project", version: 1, sku: "FOREIGN-SKU", name: "Foreign product", public_json: JSON.stringify(f.productInput.publicData), internal_json: '{"marker":"PRIVATE_FOREIGN"}' });
  let response = await readGuide(f, product);
  assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /FOREIGN-SKU|PRIVATE_FOREIGN|Foreign product/);
  const url = new URL(f.request("GET", {}, "first-video-guide").url); url.searchParams.set("projectId", "foreign-project");
  response = await f.route("first-video-guide").GET(new Request(url));
  assert.equal(response.status, 403);
  f.identity.signedIn = false;
  assert.equal((await readGuide(f)).status, 401);
});
