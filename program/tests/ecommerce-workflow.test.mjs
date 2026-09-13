import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

async function fixture(t) {
  const f = await ecommerceGenerationFixture(t); const generated = await f.generate();
  assert.equal(generated.status, 201, await generated.clone().text());
  const versionId = (await generated.json()).version.id;
  const params = { params: Promise.resolve({ taskId: f.task.id }) };
  const review = (action, extra = {}) => f.route("tasks/[taskId]/review").POST(f.request("POST", { revision: 1, versionId, action, confirmations: ["facts", "filming", "destination"], ...extra }), params);
  const accountId = f.seed("social_accounts", { platform: "douyin", account_type: "owned", display_name: "合成测试账号" });
  const publishedAt = new Date(Date.now() - 3600000).toISOString();
  const publicationInput = { versionId, accountId, platform: "douyin", externalUrl: "https://example.invalid/synthetic-video", publishedAt, traffic: "organic" };
  const publish = (extra = {}) => f.route("tasks/[taskId]/publications").POST(f.request("POST", { ...publicationInput, ...extra }), params);
  const approve = async () => { assert.equal((await review("submit")).status, 200); assert.equal((await review("approve")).status, 200); };
  const metrics = (publicationId, extra = {}) => {
    const observedAt = new Date().toISOString();
    return { publicationId, observedAt, periodStart: publishedAt, periodEnd: observedAt, attributionWindow: "发布后首小时", source: "合成后台资料，仅用于测试", scope: "video", methodology: "累计快照，不代表真实效果", views: 10, orders: 0, spendCents: 0, ...extra };
  };
  return { ...f, versionId, params, review, publish, approve, metrics, accountId };
}

test("end-to-end generation, review, publication and result backfill bind the original version", async t => {
  const f = await fixture(t);
  assert.equal((await f.publish()).status, 409);
  assert.equal((await f.review("submit")).status, 200);
  assert.equal((await f.review("approve", { confirmations: [] })).status, 400);
  assert.equal((await f.review("approve")).status, 200);
  const published = await f.publish(); assert.equal(published.status, 201, await published.clone().text());
  const publication = (await published.json()).publication;
  assert.equal((await f.review("reviewed")).status, 409);
  const input = f.metrics(publication.id);
  const saved = await f.route("metrics").POST(f.request("POST", input)); assert.equal(saved.status, 201, await saved.clone().text());
  const snapshot = (await saved.json()).snapshot; assert.equal(snapshot.summary.roas, null);
  assert.equal((await f.review("reviewed")).status, 200);
  const second = await f.generate({ idempotencyKey: "later-version", baseVersion: 1 });
  assert.equal(second.status, 201, await second.clone().text());
  const record = f.sqlite.prepare("SELECT version_id FROM ecommerce_publications WHERE id=?").get(publication.id);
  assert.equal(record.version_id, f.versionId);
  const listing = await (await f.route("publications").GET(f.request("GET"))).json();
  assert.equal(listing.publications[0].version, 1);
  assert.equal(listing.publications[0].product_name, f.productInput.name);
  const traceRequest = new Request(`http://localhost/api/ecommerce/publications?${new URLSearchParams({ ...f.scope, publicationId: publication.id })}`);
  const { trace } = await (await f.route("publications").GET(traceRequest)).json();
  assert.equal(trace.versionId, f.versionId); assert.equal(trace.version, 1);
  assert.equal(trace.applications.filter(a => a.sourceType === "component").length, 4);
  assert.equal(trace.applications.every(a => a.used && a.source.text.includes(a.sourceQuote)), true);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS|internal_json|costCents/);
  f.identity.allowed = false;
  assert.equal((await f.route("publications").GET(traceRequest)).status, 403);
  f.identity.allowed = true;
  assert.equal((await f.route("publications").GET(new Request(`http://localhost/api/ecommerce/publications?${new URLSearchParams({ ...f.scope, publicationId: "foreign" })}`))).status, 404);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks").get().current_version, 2);
  const report = await (await f.route("metrics").GET(f.request("GET"))).json();
  assert.equal(report.snapshots[0].version_id, f.versionId);
  assert.equal(report.snapshots[0].summary.canAttributeToVideo, true);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("manual edit saves a new draft and invalidates approval without overwriting original", async t => {
  const f = await fixture(t); await f.approve();
  const original = f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(f.versionId).pack_json;
  const pack = JSON.parse(original); pack.segments[0].script = "人工修改后需要重新核对开头的引用。";
  const response = await f.route("tasks/[taskId]/versions").POST(f.request("POST", { revision: 1, baseVersion: 1, pack, changeSummary: "人工改开头" }), f.params);
  assert.equal(response.status, 201, await response.clone().text());
  const version = (await response.json()).version; assert.equal(version.validation.ok, false);
  assert.equal(f.sqlite.prepare("SELECT pack_json FROM ecommerce_versions WHERE id=?").get(f.versionId).pack_json, original);
  assert.equal(f.sqlite.prepare("SELECT status FROM ecommerce_tasks").get().status, "draft");
  assert.equal((await f.publish({ versionId: version.id })).status, 409);
  assert.equal((await f.review("submit", { versionId: version.id })).status, 409);
});

test("changed task brief requires a new version before approval or publication", async t => {
  const f = await fixture(t);
  const update = await f.route("tasks").POST(f.request("POST", { id: f.task.id, revision: 1, title: "更新目标场景", productId: f.product.id, productVersionId: f.product.versionId, brief: { ...f.brief, scene: "不同的使用场景" } }));
  assert.equal(update.status, 200);
  assert.equal((await f.review("submit", { revision: 2 })).status, 409);
});

test("publication rejects foreign, benchmark and wrong-platform accounts", async t => {
  const f = await fixture(t); await f.approve();
  const foreign = f.seed("social_accounts", { project_id: "foreign-project", platform: "douyin", account_type: "owned", display_name: "foreign" });
  assert.equal((await f.publish({ accountId: foreign })).status, 409);
  f.sqlite.prepare("UPDATE social_accounts SET account_type='benchmark' WHERE id=?").run(f.accountId);
  assert.equal((await f.publish()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_publications").get().n, 0);
});

test("snapshot replay is deduplicated and corrections preserve the original data", async t => {
  const f = await fixture(t); await f.approve();
  const publication = (await (await f.publish()).json()).publication;
  const input = f.metrics(publication.id);
  const first = await f.route("metrics").POST(f.request("POST", input)); const snapshot = (await first.json()).snapshot;
  assert.equal((await f.route("metrics").POST(f.request("POST", input))).status, 200);
  assert.equal((await f.route("metrics").POST(f.request("POST", { ...input, views: 20 }))).status, 409);
  const correction = await f.route("metrics").POST(f.request("POST", { ...input, views: 20, replacesId: snapshot.id }));
  assert.equal(correction.status, 201, await correction.clone().text());
  assert.equal((await f.route("metrics").POST(f.request("POST", { ...input, views: 30, replacesId: snapshot.id }))).status, 409);
  const report = await (await f.route("metrics").GET(f.request("GET"))).json();
  assert.equal(report.snapshots.length, 2);
  const old = report.snapshots.find(row => row.id === snapshot.id);
  assert.equal(JSON.parse(old.body_json).views, 10); assert.equal(old.superseded, 1);
  assert.throws(() => f.sqlite.prepare("UPDATE ecommerce_metric_snapshots SET body_json='{}' WHERE id=?").run(snapshot.id), /correction/);
});

test("aggregate product metrics are explicitly not attributable to a single video", async t => {
  const f = await fixture(t); await f.approve();
  const publication = (await (await f.publish()).json()).publication;
  const saved = await f.route("metrics").POST(f.request("POST", f.metrics(publication.id, { scope: "product", revenueCents: 10000 })));
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).snapshot.summary.canAttributeToVideo, false);
  const empty = f.metrics(publication.id, { views: null, orders: null, spendCents: null });
  assert.equal((await f.route("metrics").POST(f.request("POST", empty))).status, 400);
});

test("final SQL rejects evidence revocation after the last JS source check", async t => {
  const f = await ecommerceGenerationFixture(t), batch = f.db.batch;
  f.db.batch = async statements => {
    if (f.calls.length === 3) f.sqlite.prepare("UPDATE ecommerce_evidence SET status='revoked',revision=revision+1").run();
    return batch(statements);
  };
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks").get().current_version, 0);
});
