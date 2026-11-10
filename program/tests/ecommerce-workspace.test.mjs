import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceFixture } from "./helpers/ecommerce-fixture.mjs";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

test("task options expose scoped public product history, confirmed knowledge and owned accounts only", async t => {
  const f = await ecommerceFixture(t); await f.enable();
  const product = await f.saveProduct();
  await f.saveProduct({ id: product.id, revision: 1, name: "修订名称", sku: f.productInput.sku });
  f.seed("social_accounts", { id: "owned", display_name: "当前自有", handle: "current", platform: "douyin", account_type: "owned" });
  f.seed("social_accounts", { id: "benchmark", display_name: "不可选对标", platform: "douyin", account_type: "benchmark" });
  f.seed("social_accounts", { id: "foreign", project_id: "foreign-project", display_name: "不可选其他空间", platform: "douyin", account_type: "owned" });
  for (const [id, status, project] of [["confirmed", "confirmed", f.projectId], ["draft", "draft", f.projectId], ["foreign", "confirmed", "foreign-project"]]) {
    f.seed("knowledge_items", { id, title: id, category: "case_study", status, project_id: project });
    f.seed("knowledge_item_versions", { item_id: id, version: 1, body: `${id}知识`, source_type: "manual", project_id: project });
  }
  const response = await f.route("options").GET(f.request("GET")); assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.products.map(p => p.version), [2, 1]);
  assert.deepEqual(data.accounts.map(a => a.id), ["owned"]);
  assert.deepEqual(data.knowledge.map(k => k.id), ["confirmed"]);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS|internal_json|costCents|marginNotes|stock/);
  f.identity.allowed = false;
  assert.equal((await f.route("options").GET(f.request("GET"))).status, 403);
});

test("account registration requires ownership, enabled scope and deduplicates without changing existing identity", async t => {
  const f = await ecommerceFixture(t), body = { displayName: "合成自有账号", handle: "synthetic-owned", platform: "douyin", confirmOwned: true };
  assert.equal((await f.route("accounts").POST(f.request("POST", body))).status, 409);
  await f.enable();
  assert.equal((await f.route("accounts").POST(f.request("POST", { ...body, confirmOwned: false }))).status, 400);
  assert.equal((await f.route("accounts").POST(f.request("POST", { ...body, projectId: "foreign-project" }))).status, 403);
  const first = await f.route("accounts").POST(f.request("POST", body)); assert.equal(first.status, 201);
  const id = (await first.json()).account.id;
  const repeated = await f.route("accounts").POST(f.request("POST", { ...body, displayName: "不得覆盖原名称" }));
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).account.id, id);
  const rows = f.sqlite.prepare("SELECT * FROM social_accounts WHERE id=?").all(id);
  assert.equal(rows.length, 1); assert.equal(rows[0].display_name, body.displayName); assert.equal(rows[0].account_type, "owned");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ecommerce.account.registered'").get().n, 1);
});

function caseSource(f) {
  const videoId = f.seed("videos", { platform: "douyin", source_type: "url", title: "合成案例", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ actual: "先展示旋盖动作，再引导查看商品规格。" }) });
  const input = { referenceId, analysisId, title: "合成案例", audience: "日常使用者", target: "product_click", hook: "使用问题", structure: "先展示旋盖动作，再引导查看商品规格。", evidenceMethod: "演示动作", cta: "查看规格", transferable: "演示结构", nonTransferable: "原作者的身份与销量", sourceQuote: "先展示旋盖动作，再引导查看商品规格。", status: "confirmed" };
  return { videoId, referenceId, analysisId, input };
}

test("case source preview respects active reference and rejects analysis or transcript substitution", async t => {
  const f = await ecommerceFixture(t), c = caseSource(f);
  const request = extra => new Request(`http://localhost/api/ecommerce/cases/source?${new URLSearchParams({ ...f.scope, referenceId: c.referenceId, analysisId: c.analysisId, ...extra })}`);
  const preview = await f.route("cases/source").GET(request()); assert.equal(preview.status, 200);
  const data = await preview.json(); assert.equal(data.sourceText, c.input.sourceQuote); assert.deepEqual(data.transcripts, []);
  assert.equal((await f.route("cases/source").GET(request({ analysisId: "unrelated" }))).status, 409);
  assert.equal((await f.route("cases/source").GET(request({ transcriptId: "unrelated" }))).status, 409);
  f.sqlite.prepare("UPDATE project_video_references SET project_id='foreign-project' WHERE id=?").run(c.referenceId);
  assert.equal((await f.route("cases/source").GET(request())).status, 409);
});

test("case edits need reconfirmation and preserve historical generated snapshots", async t => {
  const f = await ecommerceGenerationFixture(t), c = caseSource(f);
  const created = await f.route("cases").POST(f.request("POST", c.input)); assert.equal(created.status, 201);
  const id = (await created.json()).case.id;
  assert.equal((await f.route("cases").POST(f.request("POST", c.input))).status, 409);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.brief, referenceMode: "benchmark", caseIds: [id] }), f.task.id);
  assert.equal((await f.generate()).status, 201);
  const snapshot = f.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions").get().input_snapshot_json;
  const changed = { ...c.input, id, revision: 1, status: "draft", structure: "修订后的结构说明" };
  const edited = await f.route("cases").PUT(f.request("PUT", changed)); assert.equal(edited.status, 200, await edited.clone().text());
  const row = f.sqlite.prepare("SELECT * FROM ecommerce_case_profiles WHERE id=?").get(id);
  assert.equal(row.status, "draft"); assert.equal(row.confirmed_by, null); assert.equal(row.revision, 2);
  assert.equal(f.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions").get().input_snapshot_json, snapshot);
  assert.equal((await f.generate({ baseVersion: 1, idempotencyKey: "after-case-edit" })).status, 409);
  assert.equal((await f.route("cases").PUT(f.request("PUT", changed))).status, 409);
  assert.equal((await f.route("cases").PUT(f.request("PUT", { ...changed, revision: 2, sourceQuote: "不存在的来源" }))).status, 409);
  assert.equal((await f.route("cases").PATCH(f.request("PATCH", { id, revision: 2, status: "confirmed" }))).status, 200);
  assert.equal((await f.generate({ baseVersion: 1, idempotencyKey: "after-confirmation" })).status, 201);
});
