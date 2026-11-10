import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

test("expired evidence prevents new generation while preserving the previous version", async t => {
  const f = await ecommerceGenerationFixture(t);
  assert.equal((await f.generate()).status, 201);
  const original = f.sqlite.prepare("SELECT * FROM ecommerce_versions").get();
  f.sqlite.prepare("UPDATE ecommerce_evidence SET valid_until='2000-01-01T00:00:00Z' WHERE id=?").run(f.evidenceId);
  const response = await f.generate({ baseVersion: 1, idempotencyKey: "expired" });
  assert.equal(response.status, 409);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM ecommerce_versions").get(), original);
});

test("evidence attachments from another space cannot be imported or used for generation", async t => {
  const f = await ecommerceGenerationFixture(t);
  const mediaId = f.seed("media_assets", { project_id: "foreign-project", status: "active", kind: "report", r2_key: "synthetic/foreign-report", filename: "synthetic.txt", content_type: "text/plain", size_bytes: 0, sha256: "synthetic" });
  const response = await f.route("evidence").POST(f.request("POST", {
    productId: f.product.id, title: "合成附件越权检查", kind: "demonstration", body: "旋盖动作", sourceLocator: "synthetic fixture", mediaAssetId: mediaId, status: "confirmed",
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "MEDIA_UNAVAILABLE");
  f.sqlite.prepare("UPDATE ecommerce_evidence SET media_asset_id=? WHERE id=?").run(mediaId, f.evidenceId);
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 0);
});

test("no eligible methods returns missing categories without starting a model call", async t => {
  const f = await ecommerceGenerationFixture(t);
  f.sqlite.prepare("UPDATE ecommerce_components SET status='revoked'").run();
  const response = await f.route("tasks/[taskId]/recommendations").GET(f.request("GET"), { params: Promise.resolve({ taskId: f.task.id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ready, false);
  for (const kind of ["开头", "文案结构"]) assert.ok(body.missing.some(value => value.includes(kind)));
  assert.equal(body.missing.some(value => /可视化|拍摄/.test(value)), false);
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 0);
});

test("strategy conflict requires an explicit task exception and never edits the account strategy", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result }) => stage === "plan" ? { ...result, strategyConflict: "本次商品点击目标需作为账号方向的例外确认" } : result });
  const strategyBefore = f.sqlite.prepare("SELECT * FROM content_strategies").all();
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /策略例外/);
  assert.equal(f.calls.length, 1);
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=?,revision=2 WHERE id=?").run(JSON.stringify({ ...f.brief, strategyException: "人工确认：本条用于商品功能演示与商品点击测试" }), f.task.id);
  assert.equal((await f.generate({ revision: 2, idempotencyKey: "confirmed-exception" })).status, 201);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM content_strategies").all(), strategyBefore);
  const snapshot = JSON.parse(f.sqlite.prepare("SELECT input_snapshot_json FROM ecommerce_versions").get().input_snapshot_json);
  assert.match(JSON.stringify(snapshot), /人工确认：本条/);
});

test("review cannot use a method card as evidence for product facts", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, payload, result }) => {
    if (stage === "review") for (const check of result.claimChecks) check.sourceIds = [payload.context.candidates[0].id];
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /事实校对缺少支持/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
});

test("sales figures in an external case cannot become facts about the selected product", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result }) => {
    if (["draft", "repair"].includes(stage)) result.segments[1].script += "本商品已售出99999件。";
    return result;
  } });
  const videoId = f.seed("videos", { platform: "douyin", source_type: "url", title: "合成外部案例", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const sourceQuote = "先展示旋盖动作，再引导查看商品规格。原作者声称售出99999件。";
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "synthetic", report_json: JSON.stringify({ actual: sourceQuote }) });
  const created = await f.route("cases").POST(f.request("POST", { referenceId, analysisId, title: "合成外部案例", audience: "日常使用者", target: "product_click", hook: "使用问题", structure: "先演示再引导", evidenceMethod: "动作演示", cta: "查看规格", transferable: "演示结构", nonTransferable: "原作者身份及99999件销量", sourceQuote, status: "confirmed" }));
  assert.equal(created.status, 201);
  const caseId = (await created.json()).case.id;
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify({ ...f.brief, referenceMode: "benchmark", caseIds: [caseId] }), f.task.id);
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /没有资料依据的数字：99999/);
  assert.ok(f.calls[0].payload.context.cases.some(c => c.id === caseId && c.text.includes("99999")));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM ecommerce_versions").get().n, 0);
});
