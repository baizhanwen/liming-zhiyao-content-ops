import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

test("source selection keeps explicit knowledge and excludes memory and publication queries", async t => {
  const f = await ecommerceGenerationFixture(t);
  for (const name of ["selected", "unselected"]) {
    f.seed("knowledge_items", { id: name, title: name, category: "case_study", status: "confirmed" });
    f.seed("knowledge_item_versions", { item_id: name, version: 1, body: `${name}独立资料`, source_type: "manual" });
  }
  const brief = { ...f.brief, knowledgeIds: ["selected"] };
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify(brief), f.task.id);
  const queries = [], prepare = f.db.prepare;
  f.db.prepare = q => { queries.push(q); return prepare(q); };
  const response = await f.generate(); assert.equal(response.status, 201, await response.clone().text());
  assert.match(JSON.stringify(f.calls), /selected独立资料/);
  assert.doesNotMatch(JSON.stringify(f.calls), /unselected独立资料/);
  assert.equal(queries.some(q => /FROM (project_memory_items|published_copy_records|video_knowledge_atoms)/.test(q)), false);
});

test("copy method filtering rejects wrong platforms and skips saved shooting methods", async t => {
  const f = await ecommerceGenerationFixture(t);
  const extra = { name: "不适配测试", kind: "hook", instruction: "测试", problem: "旋盖", platforms: ["xiaohongshu"], targets: ["product_click"], requiredFilming: [], inputContract: "测试", outputContract: "测试", sourceLocator: "synthetic fixture", sourceVersion: "2", authorization: "测试", status: "confirmed" };
  const added = await f.route("components").POST(f.request("POST", extra)); assert.equal(added.status, 201);
  const id = (await added.json()).component.id;
  const request = new Request(`http://localhost?${new URLSearchParams(f.scope)}`), params = { params: Promise.resolve({ taskId: f.task.id }) };
  const result = await (await f.route("tasks/[taskId]/recommendations").GET(request, params)).json();
  assert.equal(result.ready, true);
  assert.equal(result.candidates.some(c => c.id === id), false);
  assert.deepEqual(result.rejected.find(c => c.id === id).reasons, ["平台不匹配"]);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.brief, componentIds: [id] }), f.task.id);
  assert.equal((await f.route("tasks/[taskId]/recommendations").GET(request, params)).status, 409);
  assert.equal(f.calls.length, 0);
  const revised = await f.route("components").POST(f.request("POST", { ...extra, id, revision: 1, platforms: ["douyin"], requiredFilming: ["location"] }));
  assert.equal(revised.status, 200, await revised.clone().text());
  const eligible = await (await f.route("tasks/[taskId]/recommendations").GET(request, params)).json();
  assert.equal(eligible.ready, true);
  assert.equal(eligible.candidates.some(c => c.id === id), false, "shooting instructions must not enter the copy context");
  assert.deepEqual(eligible.rejected.find(c => c.id === id).reasons, ["拍摄方法不用于文案"]);
  assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT brief_json FROM ecommerce_tasks WHERE id=?").get(f.task.id).brief_json).componentIds, [id], "saved historical method selection is preserved");
});

test("case import binds actual report text and only current-space video references", async t => {
  const f = await ecommerceGenerationFixture(t);
  const videoId = f.seed("videos", { platform: "douyin", source_type: "url", title: "合成案例", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ actual: "先展示旋盖动作，再引导查看商品规格。" }) });
  const input = { referenceId, analysisId, title: "合成案例", audience: "日常使用者", target: "product_click", hook: "使用问题", structure: "先展示旋盖动作，再引导查看商品规格。", evidenceMethod: "演示动作", cta: "查看规格", transferable: "演示结构", nonTransferable: "原作者的身份与销量", sourceQuote: "先展示旋盖动作，再引导查看商品规格。", status: "confirmed" };
  const created = await f.route("cases").POST(f.request("POST", input)); assert.equal(created.status, 201, await created.clone().text());
  const id = (await created.json()).case.id;
  assert.equal((await f.route("cases").POST(f.request("POST", { ...input, sourceQuote: "没有出现过的销量保证" }))).status, 409);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.brief, referenceMode: "benchmark", caseIds: [id] }), f.task.id);
  const response = await f.generate(); assert.equal(response.status, 201, await response.clone().text());
  const planInput = f.calls.find(c => c.stage === "plan").payload.context;
  assert.equal(planInput.cases[0].id, id); assert.match(planInput.cases[0].nonTransferable, /销量/);
  f.sqlite.prepare("UPDATE project_video_references SET status='revoked' WHERE id=?").run(referenceId);
  assert.equal((await f.generate({ baseVersion: 1, idempotencyKey: "after-revoke" })).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 1);
});
