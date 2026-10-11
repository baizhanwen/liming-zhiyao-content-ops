import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

const operations = ["product-create", "product-update", "task-create", "task-update", "evidence-create", "evidence-confirm", "component-create", "component-update", "case-create", "case-update", "case-confirm", "account", "metrics", "correction", "settings-create", "settings-update", "starter", "cancel", "recover", "manual", "submit", "approve", "return", "archive", "reviewed", "publish"];
async function fixture(t, operation) {
  const f = await ecommerceGenerationFixture(t), generated = await f.generate();
  assert.equal(generated.status, 201, await generated.clone().text());
  const versionId = (await generated.json()).version.id, params = { params: Promise.resolve({ taskId: f.task.id }) };
  const review = action => f.route("tasks/[taskId]/review").POST(f.request("POST", { revision: 1, versionId, action, confirmations: ["facts", "filming", "destination"], note: "合成审核意见" }), params);
  const accountId = f.seed("social_accounts", { platform: "douyin", account_type: "owned", display_name: "合成账号" });
  const publishedAt = new Date(Date.now() - 3600000).toISOString(), observedAt = new Date().toISOString();
  const publish = () => f.route("tasks/[taskId]/publications").POST(f.request("POST", { versionId, accountId, platform: "douyin", externalUrl: "https://example.invalid/mutation-test", publishedAt, traffic: "organic" }), params);
  if (["approve", "return", "publish", "metrics", "correction", "reviewed"].includes(operation)) assert.equal((await review("submit")).status, 200);
  if (["publish", "metrics", "correction", "reviewed"].includes(operation)) assert.equal((await review("approve")).status, 200);
  let publicationId, snapshotId;
  const metric = () => ({ publicationId, observedAt, periodStart: publishedAt, periodEnd: observedAt, attributionWindow: "首小时", source: "合成数据", scope: "video", methodology: "合成累计快照", views: 10, orders: 0 });
  if (["metrics", "correction", "reviewed"].includes(operation)) { const response = await publish(); assert.equal(response.status, 201); publicationId = (await response.json()).publication.id; }
  if (["correction", "reviewed"].includes(operation)) { const response = await f.route("metrics").POST(f.request("POST", metric())); assert.equal(response.status, 201); snapshotId = (await response.json()).snapshot.id; }
  const videoId = f.seed("videos", { platform: "douyin", source_type: "url", title: "合成案例", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ actual: "先展示旋盖动作，再引导查看商品规格。" }) });
  const caseInput = { referenceId, analysisId, title: "合成案例", audience: "日常使用者", target: "product_click", hook: "使用问题", structure: "先展示旋盖动作，再引导查看商品规格。", evidenceMethod: "演示动作", cta: "查看规格", transferable: "演示结构", nonTransferable: "原作者身份与销量", sourceQuote: "先展示旋盖动作，再引导查看商品规格。", status: "draft" };
  let caseId;
  if (["case-update", "case-confirm"].includes(operation)) { const r = await f.route("cases").POST(f.request("POST", caseInput)); assert.equal(r.status, 201); caseId = (await r.json()).case.id; }
  const component = f.sqlite.prepare("SELECT c.id,c.revision,v.body_json FROM ecommerce_components c JOIN ecommerce_component_versions v ON v.component_id=c.id AND v.version=c.current_version LIMIT 1").get();
  const pack = JSON.parse(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(versionId).pack_json);
  if (operation === "settings-create") f.sqlite.prepare("DELETE FROM ecommerce_project_settings").run();
  const runId = ["cancel", "recover"].includes(operation) ? f.seed("ecommerce_generation_runs", { task_id: f.task.id, idempotency_key: "held-mutation", input_hash: "synthetic", base_version: 1, task_revision: 1, operation: "generate", status: "running", created_at: new Date(Date.now() - 600000).toISOString() }) : null;
  const start = () => {
    switch (operation) {
      case "product-create": return f.route("products").POST(f.request("POST", { ...f.productInput, sku: "SECOND-SYNTHETIC" }));
      case "product-update": return f.route("products").POST(f.request("POST", { ...f.productInput, id: f.product.id, revision: 2, name: "合成修改" }));
      case "task-create": return f.route("tasks").POST(f.request("POST", { title: "合成新任务", productId: f.product.id, productVersionId: f.product.versionId, brief: f.brief }));
      case "task-update": return f.route("tasks").POST(f.request("POST", { id: f.task.id, revision: 1, title: "合成修改任务", productId: f.product.id, productVersionId: f.product.versionId, brief: f.brief }));
      case "evidence-create": return f.route("evidence").POST(f.request("POST", { productId: f.product.id, title: "合成证据", kind: "demonstration", body: "合成演示", sourceLocator: "合成出处", status: "draft" }));
      case "evidence-confirm": return f.route("evidence").PATCH(f.request("PATCH", { id: f.evidenceId, revision: 1, status: "confirmed" }));
      case "component-create": return f.route("components").POST(f.request("POST", { ...JSON.parse(component.body_json), name: "合成新方法", sourceVersion: "2" }));
      case "component-update": return f.route("components").POST(f.request("POST", { ...JSON.parse(component.body_json), id: component.id, revision: component.revision, name: "合成修改方法" }));
      case "case-create": return f.route("cases").POST(f.request("POST", caseInput));
      case "case-update": return f.route("cases").PUT(f.request("PUT", { ...caseInput, id: caseId, revision: 1, title: "合成修改案例" }));
      case "case-confirm": return f.route("cases").PATCH(f.request("PATCH", { id: caseId, revision: 1, status: "confirmed" }));
      case "account": return f.route("accounts").POST(f.request("POST", { displayName: "合成第二账号", handle: "synthetic-account", platform: "douyin", confirmOwned: true }));
      case "metrics": return f.route("metrics").POST(f.request("POST", metric()));
      case "correction": return f.route("metrics").POST(f.request("POST", { ...metric(), replacesId: snapshotId, views: 20 }));
      case "settings-create": case "settings-update": return f.route("settings").PUT(f.request("PUT", { enabled: true, revision: operation === "settings-create" ? 0 : 1, monthlyCallLimit: 20 }));
      case "starter": return f.route("components/starter").POST(f.request("POST", { keys: [f.load("lib/ecommerce/starter-catalog.ts").ECOMMERCE_STARTER_CARDS[0].key], confirm: true }));
      case "cancel": case "recover": return f.route("tasks/[taskId]/runs").POST(f.request("POST", { runId, action: operation }), params);
      case "manual": return f.route("tasks/[taskId]/versions").POST(f.request("POST", { revision: 1, baseVersion: 1, pack, changeSummary: "合成人工修改" }), params);
      case "submit": case "approve": case "archive": case "reviewed": return review(operation);
      case "return": return review("changes_requested");
      case "publish": return publish();
    }
    throw new Error(operation);
  };
  return { ...f, start, metric, publicationId };
}
function snapshot(f) {
  const tables = f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'ecommerce_%' OR name IN ('social_accounts','audit_logs','model_calls','generation_source_manifests')) ORDER BY name").all();
  return tables.map(({ name }) => [name, f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
function injectAtWrite(f, mutate, skip = 0) {
  const batch = f.db.batch; let injected = false, attempts = 0;
  f.db.batch = async statements => { if (!injected && attempts++ >= skip) { injected = true; mutate(); } return batch(statements); };
  return () => assert.ok(injected, "fault must reach the actual write transaction");
}
for (const operation of operations) test(`current member revocation rejects ${operation} without changing business rows`, async t => {
  const f = await fixture(t, operation), before = snapshot(f), verify = injectAtWrite(f, () => f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.identity.userId), operation === "settings-update" ? 1 : 0);
  const response = await f.start(); verify(); assert.equal(response.status, 403, await response.clone().text()); assert.deepEqual(snapshot(f), before);
});
for (const operation of ["settings-create", "settings-update", "starter", "recover"]) test(`administrator demotion cannot complete ${operation}`, async t => {
  const f = await fixture(t, operation), before = snapshot(f);
  f.seed("project_members", { user_id: f.identity.userId, role: "member", status: "active" });
  const verify = injectAtWrite(f, () => f.sqlite.prepare("UPDATE organization_members SET role='employee' WHERE user_id=?").run(f.identity.userId), operation === "settings-update" ? 1 : 0);
  const response = await f.start(); verify(); assert.equal(response.status, 403, await response.clone().text()); assert.deepEqual(snapshot(f), before);
});
for (const [name, change] of [
  ["disabled user", f => f.sqlite.prepare("UPDATE users SET status='inactive' WHERE id=?").run(f.identity.userId)],
  ["disabled company", f => f.sqlite.prepare("UPDATE organizations SET status='inactive' WHERE id=?").run(f.organizationId)],
  ["archived project", f => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.projectId)],
  ["removed employee assignment", f => { f.sqlite.prepare("UPDATE organization_members SET role='employee' WHERE user_id=?").run(f.identity.userId); f.sqlite.prepare("UPDATE project_members SET status='inactive' WHERE user_id=?").run(f.identity.userId); }],
]) test(`${name} blocks metric writes in SQL`, async t => {
  const f = await fixture(t, "metrics"), before = snapshot(f); f.seed("project_members", { user_id: f.identity.userId, role: "member", status: "active" });
  const verify = injectAtWrite(f, () => change(f)), response = await f.start(); verify(); assert.equal(response.status, 403, await response.clone().text()); assert.deepEqual(snapshot(f), before);
});
test("all mutation controls can still succeed with current authority", async t => {
  for (const operation of operations) { const f = await fixture(t, operation), r = await f.start(); assert.ok([200, 201].includes(r.status), `${operation}: ${r.status} ${await r.text()}`); assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
});
test("two metric writers cannot silently save different values for the same observation", async t => {
  const f = await fixture(t, "metrics"), input = f.metric();
  const results = await Promise.all([f.route("metrics").POST(f.request("POST", input)), f.route("metrics").POST(f.request("POST", { ...input, views: 20 }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_metric_snapshots").get().n, 1);
});
test("concurrent identical metric replay returns the same record", async t => {
  const f = await fixture(t, "metrics"), input = f.metric();
  const results = await Promise.all([f.route("metrics").POST(f.request("POST", input)), f.route("metrics").POST(f.request("POST", input))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]); assert.equal((await results[0].json()).snapshot.id, (await results[1].json()).snapshot.id);
});
for (const operation of ["product-create", "task-update", "manual", "approve", "publish", "metrics"]) test(`expired request identity after entry blocks ${operation}`, async t => {
  const f = await fixture(t, operation), before = snapshot(f), prepare = f.db.prepare;
  let expired = false;
  f.db.prepare = sql => { const statement = prepare(sql), first = statement.first;
    statement.first = async () => { const row = await first(); if (!expired) { expired = true; f.identity.signedIn = false; } return row; }; return statement;
  };
  const response = await f.start(); assert.ok(expired); assert.equal(response.status, 401, await response.clone().text()); assert.deepEqual(snapshot(f), before);
});
for (const identical of [false, true]) test(`concurrent ${identical ? "identical" : "different"} corrections preserve one successor`, async t => {
  const f = await fixture(t, "correction"), original = f.sqlite.prepare("SELECT * FROM ecommerce_metric_snapshots").get();
  const input = { ...f.metric(), replacesId: original.id, views: 20 };
  const results = await Promise.all([f.route("metrics").POST(f.request("POST", input)), f.route("metrics").POST(f.request("POST", { ...input, views: identical ? 20 : 30 }))]);
  assert.deepEqual(results.map(r => r.status).sort(), identical ? [200, 201] : [201, 409]);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM ecommerce_metric_snapshots WHERE id=?").get(original.id), original);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_metric_snapshots WHERE replaces_id=?").get(original.id).n, 1);
});
for (const operation of ["manual", "publish"]) test(`dependent ${operation} row failure rolls back task and audit`, async t => {
  const f = await fixture(t, operation), before = snapshot(f), table = operation === "manual" ? "ecommerce_versions" : "ecommerce_publications";
  f.sqlite.exec(`CREATE TRIGGER fail_mutation BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic dependent write failure'); END;`);
  const r = await f.start(); assert.equal(r.status, 500); assert.deepEqual(snapshot(f), before);
});
