import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { ecommerceFixture } from "./helpers/ecommerce-fixture.mjs";
import { metricsSchema, productSchema, componentSchema } from "../lib/ecommerce/contracts.ts";

test("additive migration preserves every old schema and row; database backup restores the baseline", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory).filter(n => n.endsWith(".sql") && n < "0048").sort()) db.exec(readFileSync(new URL(name, directory), "utf8"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id,auth_subject,email,created_at,updated_at) VALUES ('legacy','legacy','legacy@example.invalid',?,?)").run(now, now);
  const oldNames = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const snapshot = () => oldNames.map(({ name }) => ({ name, schema: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql, rows: db.prepare(`SELECT * FROM "${name}"`).all() }));
  const before = snapshot(), temp = mkdtempSync(path.join(tmpdir(), "commerce-migration-"));
  let restored;
  t.after(() => { restored?.close(); rmSync(temp, { recursive: true, force: true }); });
  const backupPath = path.join(temp, "baseline.sqlite"); await backup(db, backupPath);
  db.exec(readFileSync(new URL("0048_ecommerce_foundation.sql", directory), "utf8"));
  assert.deepEqual(snapshot(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ecommerce_tasks").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ecommerce_project_settings").get().n, 0);
  restored = new DatabaseSync(backupPath);
  for (const table of before) assert.deepEqual(restored.prepare(`SELECT * FROM "${table.name}"`).all(), table.rows);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'ecommerce_%'").get().n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("module defaults off, rejects writes, and only an administrator can enable it", async t => {
  const f = await ecommerceFixture(t);
  const settings = f.route("settings");
  assert.equal((await (await settings.GET(f.request("GET"))).json()).settings.enabled, 0);
  assert.equal((await f.route("products").POST(f.request("POST", f.productInput))).status, 409);
  f.identity.role = "member";
  assert.equal((await settings.PUT(f.request("PUT", { enabled: true, revision: 0 }))).status, 403);
  f.identity.role = "admin"; await f.enable();
  assert.equal((await settings.PUT(f.request("PUT", { enabled: false, revision: 0 }))).status, 409);
  assert.equal((await settings.PUT(f.request("PUT", { enabled: false, revision: 1 }))).status, 200);
  assert.equal((await f.route("products").POST(f.request("POST", f.productInput))).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'ecommerce.settings.%'").get().n, 2);
});

test("scope and login checks reject read and write access", async t => {
  const f = await ecommerceFixture(t); await f.enable(); await f.saveProduct();
  f.identity.allowed = false;
  assert.equal((await f.route("products").GET(f.request("GET"))).status, 403);
  assert.equal((await f.route("settings").PUT(f.request("PUT", { enabled: false, revision: 1 }))).status, 403);
  f.identity.signedIn = false;
  assert.equal((await f.route("evidence").GET(f.request("GET"))).status, 401);
});

test("product revisions are immutable and stale updates cannot create orphan versions", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const product = await f.saveProduct();
  const second = await f.saveProduct({ id: product.id, revision: 1, name: "新名称" });
  assert.equal(second.revision, 2);
  const conflict = await f.route("products").POST(f.request("POST", { ...f.productInput, id: product.id, revision: 1 }));
  assert.equal(conflict.status, 409);
  const versions = f.sqlite.prepare("SELECT * FROM ecommerce_product_versions ORDER BY version").all();
  assert.equal(versions.length, 2); assert.equal(versions[0].name, f.productInput.name);
  assert.throws(() => f.sqlite.prepare("UPDATE ecommerce_product_versions SET name='changed' WHERE id=?").run(product.versionId), /immutable/);
  assert.doesNotMatch(versions[0].public_json, /PRIVATE_|12345|987/);
  assert.match(versions[0].internal_json, /PRIVATE_TEST_ONLY/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM content_items").get().n, 0);
});

test("explicit evidence must belong to the same product and remain confirmed", async t => {
  const f = await ecommerceFixture(t); await f.enable(); const product = await f.saveProduct();
  const foreign = f.seed("ecommerce_products", { id: "foreign", project_id: "foreign-project", sku: "foreign", name: "foreign" });
  f.seed("ecommerce_evidence", { id: "foreign-evidence", project_id: "foreign-project", product_id: foreign, title: "foreign", kind: "specification", body_json: "{}", content_hash: "x", status: "confirmed" });
  const input = { ...f.productInput, id: product.id, revision: 1, status: "confirmed", publicData: { ...f.productInput.publicData, claims: [{ id: "claim", statement: "合成容量说明", allowedExpression: "合成容量说明", kind: "specification", evidenceIds: ["foreign-evidence"], status: "confirmed" }] } };
  assert.equal((await f.route("products").POST(f.request("POST", input))).status, 409);
  const evidence = await f.route("evidence").POST(f.request("POST", { productId: product.id, title: "合成规格", kind: "specification", body: "合成容量说明", sourceLocator: "合成证据，不代表真实商品", status: "confirmed" }));
  assert.equal(evidence.status, 201, await evidence.clone().text());
  const evidenceId = (await evidence.json()).evidence.id;
  input.publicData.claims[0].evidenceIds = [evidenceId];
  assert.equal((await f.route("products").POST(f.request("POST", input))).status, 200);
  assert.equal((await f.route("evidence").PATCH(f.request("PATCH", { id: evidenceId, revision: 1, status: "revoked" }))).status, 200);
  input.revision = 2;
  assert.equal((await f.route("products").POST(f.request("POST", input))).status, 409);
  const fk = f.sqlite.prepare("PRAGMA foreign_keys").get(); assert.equal(fk.foreign_keys, 1);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("private component import cannot promote itself to system or update another scope", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const input = { name: "合成钩子", kind: "hook", instruction: "从任务中已确认的使用场景开始", problem: "让受众理解场景", platforms: ["douyin"], targets: ["product_click"], inputContract: "场景", outputContract: "开头", sourceLocator: "synthetic fixture", sourceVersion: "1", authorization: "合成测试", status: "confirmed" };
  const response = await f.route("components").POST(f.request("POST", input));
  assert.equal(response.status, 201, await response.clone().text());
  const component = (await response.json()).component;
  assert.equal((await f.route("components").POST(f.request("POST", { ...input, scope: "system" }))).status, 400);
  f.sqlite.prepare("UPDATE ecommerce_components SET project_id='foreign-project' WHERE id=?").run(component.id);
  assert.equal((await f.route("components").POST(f.request("POST", { ...input, id: component.id, revision: 1 }))).status, 409);
  assert.equal((await (await f.route("components").GET(f.request("GET"))).json()).components.length, 0);
});

test("request size and unknown public fields are rejected", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  assert.equal((await f.route("products").POST(f.request("POST", { ...f.productInput, publicData: { ...f.productInput.publicData, stock: 987 } }))).status, 400);
  const large = new Request("http://localhost", { method: "POST", body: JSON.stringify({ padding: "x".repeat(140000) }) });
  assert.equal((await f.route("products").POST(large)).status, 413);
  assert.equal(productSchema.safeParse({ ...f.scope, ...f.productInput, publicData: { ...f.productInput.publicData, claims: [], costCents: 42 } }).success, false);
  assert.equal(componentSchema.safeParse({ ...f.scope, system: true }).success, false);
});

test("metrics distinguish null from zero, reject impossible counts and unclear ROI", () => {
  const input = { organizationId: "org", projectId: "project", publicationId: "publication", observedAt: "2026-09-13T10:00:00Z", periodStart: "2026-09-12T10:00:00Z", periodEnd: "2026-09-13T10:00:00Z", attributionWindow: "24小时", source: "合成测试", scope: "video", methodology: "累计快照" };
  const parsed = metricsSchema.parse({ ...input, views: 0 });
  assert.equal(parsed.views, 0); assert.equal(parsed.orders, null); assert.equal(parsed.spendCents, null);
  assert.equal(metricsSchema.safeParse({ ...input, views: 1, completedViews: 2 }).success, false);
  assert.equal(metricsSchema.safeParse({ ...input, platformRoi: 3 }).success, false);
  assert.equal(metricsSchema.safeParse({ ...input, stayedViews: 1 }).success, false);
});

test("task inputs bind a real product version without creating a topic and reject stale writes", async t => {
  const f = await ecommerceFixture(t); await f.enable(); const product = await f.saveProduct();
  const input = { title: "合成电商任务", productId: product.id, productVersionId: product.versionId, revision: 0, brief: { audience: {} } };
  const created = await f.route("tasks").POST(f.request("POST", input));
  assert.equal(created.status, 201, await created.clone().text());
  const task = (await created.json()).task;
  const update = { ...input, id: task.id, revision: 1, title: "修改任务" };
  assert.equal((await f.route("tasks").POST(f.request("POST", update))).status, 200);
  assert.equal((await f.route("tasks").POST(f.request("POST", update))).status, 409);
  const read = new Request(`http://localhost/api/ecommerce/tasks?${new URLSearchParams({ ...f.scope, taskId: task.id })}`);
  const body = await (await f.route("tasks").GET(read)).json();
  assert.equal(body.task.title, "修改任务"); assert.deepEqual(body.versions, []);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_memory_items").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM content_items").get().n, 0);
  assert.equal((await f.route("tasks").POST(f.request("POST", { ...input, productVersionId: "missing" }))).status, 409);
  assert.equal((await f.route("tasks").POST(f.request("POST", { ...input, brief: { audience: {}, knowledgeIds: ["missing"] } }))).status, 409);
});

test("disable between authorization and commit prevents product and version writes", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const batch = f.db.batch;
  f.db.batch = async statements => {
    f.sqlite.prepare("UPDATE ecommerce_project_settings SET enabled=0 WHERE project_id=?").run(f.projectId);
    return batch(statements);
  };
  assert.equal((await f.route("products").POST(f.request("POST", f.productInput))).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_products").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_product_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='ecommerce.product.saved'").get().n, 0);
});
