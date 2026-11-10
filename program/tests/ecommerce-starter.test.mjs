import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceFixture } from "./helpers/ecommerce-fixture.mjs";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

const install = (f, keys) => f.route("components/starter").POST(f.request("POST", { keys, confirm: true }));

test("delivery without authorized starter catalog exposes no importable methods", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  f.mock("lib/ecommerce/starter-catalog.ts", { ECOMMERCE_STARTER_VERSION: "excluded", ECOMMERCE_STARTER_CARDS: [] });
  const result = await (await f.route("components/starter").GET(f.request("GET"))).json();
  assert.deepEqual(result.cards, []); assert.equal(result.canImport, false);
  assert.equal((await install(f, ["scene-question"])).status, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_components").get().n, 0);
});

test("starter catalog traces each adaptation to authorized methods and is never performance evidence", async t => {
  const f = await ecommerceFixture(t);
  const response = await f.route("components/starter").GET(f.request("GET"));
  assert.equal(response.status, 200);
  const { cards, canImport } = await response.json(); assert.equal(canImport, false);
  assert.deepEqual([...new Set(cards.map(c => c.card.kind))].sort(), ["hook", "sop", "structure", "visual"]);
  assert.equal(cards.length, 12);
  for (const { methods, card } of cards) {
    assert.ok(methods.length);
    for (const method of methods) {
      assert.ok(method.source.revision); assert.ok(method.source.document);
      assert.ok(card.sourceLocator.includes(method.id)); assert.ok(card.sourceVersion.includes(method.version));
    }
    assert.match(card.authorization, /未经真实投放或成交验证/);
    assert.equal(card.status, "confirmed");
  }
  assert.equal((await install(f, [cards[0].key])).status, 409);
});

test("only administrators can import approved server catalog into their enabled space", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  f.identity.role = "member"; assert.equal((await install(f, ["scene-question"])).status, 403);
  f.identity.role = "admin";
  assert.equal((await install(f, ["invented"])).status, 400);
  assert.equal((await f.route("components/starter").POST(f.request("POST", { keys: ["scene-question"], confirm: true, scope: "system" }))).status, 400);
  const response = await install(f, ["scene-question", "hands-demo"]); assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).imported, 2);
  for (const row of f.sqlite.prepare("SELECT * FROM ecommerce_components").all()) {
    assert.equal(row.scope, "project"); assert.equal(row.project_id, f.projectId); assert.equal(row.organization_id, f.organizationId);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_component_versions WHERE confirmed_by=?").get(f.identity.userId).n, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='ecommerce.component.starter_imported'").get().n, 2);
});

test("reimport preserves edited private cards and their revision history without duplicating", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  await install(f, ["scene-question"]);
  const original = f.sqlite.prepare("SELECT c.id,c.revision,v.body_json FROM ecommerce_components c JOIN ecommerce_component_versions v ON v.component_id=c.id").get();
  const edited = await f.route("components").POST(f.request("POST", { ...JSON.parse(original.body_json), id: original.id, revision: original.revision, name: "我的场景提问", sourceLocator: "已由本企业修改", instruction: "使用当前任务场景提问，保持简短。" }));
  assert.equal(edited.status, 200, await edited.clone().text());
  const replay = await install(f, ["scene-question", "scene-question"]); assert.equal((await replay.json()).imported, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_components").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_component_versions").get().n, 2);
  assert.equal(f.sqlite.prepare("SELECT name FROM ecommerce_components").get().name, "我的场景提问");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='ecommerce.component.starter_imported'").get().n, 1);
});

test("starter catalog can supply writing methods without requiring real filming conditions", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.sqlite.prepare("DELETE FROM ecommerce_component_versions").run();
  f.sqlite.prepare("DELETE FROM ecommerce_components").run();
  const cards = (await (await f.route("components/starter").GET(f.request("GET"))).json()).cards;
  const imported = await install(f, cards.map(c => c.key)); assert.equal((await imported.json()).imported, 12);
  const recommendations = await f.route("tasks/[taskId]/recommendations").GET(f.request("GET"), { params: Promise.resolve({ taskId: f.task.id }) });
  assert.equal(recommendations.status, 200, await recommendations.clone().text());
  const body = await recommendations.json(); assert.equal(body.ready, true);
  assert.deepEqual([...new Set(body.candidates.map(c => c.card.kind))].sort(), ["hook", "structure"]);
  const names = body.candidates.map(c => c.card.name);
  assert.ok(names.includes("使用场景提问")); assert.ok(!names.includes("已核实权益开头"));
  assert.ok(!names.includes("手部操作演示")); assert.ok(!names.includes("规格与实物细节"));
  for (const kind of ["hook", "structure"]) assert.ok(body.candidates.filter(c => c.card.kind === kind).length <= 5);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_items").get().n, 0);
});
