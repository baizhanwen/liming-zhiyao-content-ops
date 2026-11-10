import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

function reference(f, projectId = f.projectId) {
  const videoId = f.seed("videos", { platform: "douyin", source_type: "url", title: "合成对标带货视频", status: "ready" });
  const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
  const referenceId = f.seed("project_video_references", { project_id: projectId, library_entry_id: libraryId, purpose: "benchmark", status: "active" });
  const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ structure: "先提出使用顾虑，再说明已核实资料，最后邀请查看商品卡。", originalProduct: "参考作者声称销量百万，不是本商品事实。" }) });
  const transcriptId = f.seed("video_transcripts", { video_id: videoId, version: 1, language: "zh-CN", source: "manual", full_text: "买之前先确认适不适合自己，再核对商品资料，最后去商品卡了解。", segments_json: "[]" });
  return { referenceId, analysisId, transcriptId, videoId };
}
function setBrief(f, additions) {
  const brief = { ...f.brief, ...additions };
  f.sqlite.prepare("UPDATE ecommerce_tasks SET brief_json=? WHERE id=?").run(JSON.stringify(brief), f.task.id);
  return brief;
}

test("method mode never adopts matching benchmarks implicitly", async t => {
  const f = await ecommerceGenerationFixture(t), source = reference(f);
  const created = await f.route("cases").POST(f.request("POST", { referenceId: source.referenceId, analysisId: source.analysisId, transcriptId: source.transcriptId, title: "匹配使用顾虑的旧案例", audience: "日常使用者", target: "product_click", hook: "使用顾虑", structure: "先提出使用顾虑，再说明已核实资料，最后邀请查看商品卡。", evidenceMethod: "核对资料", cta: "商品卡", transferable: "使用顾虑与资料核对顺序", nonTransferable: "参考作者的产品和销量", sourceQuote: "先提出使用顾虑，再说明已核实资料，最后邀请查看商品卡。", status: "confirmed" }));
  assert.equal(created.status, 201, await created.clone().text());
  const caseId = (await created.json()).case.id;
  setBrief(f, { referenceMode: "method", caseIds: [caseId], benchmark: { referenceId: source.referenceId, analysisId: source.analysisId, transcriptId: source.transcriptId } });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  const context = f.calls[0].payload.context;
  assert.equal(context.task.brief.referenceMode, "method");
  assert.deepEqual(context.cases, []);
  assert.deepEqual(context.task.brief.caseIds, []);
  assert.equal(context.task.brief.benchmark, null);
  assert.ok(context.candidates.length >= 2);
  assert.equal(context.sources.some(item => item.type === "case"), false);
});

test("direct benchmark mode requires one selected video and no method cards", async t => {
  const f = await ecommerceGenerationFixture(t), selected = reference(f);
  f.sqlite.prepare("UPDATE ecommerce_components SET status='revoked'").run();
  setBrief(f, { referenceMode: "benchmark", benchmark: { referenceId: selected.referenceId, analysisId: selected.analysisId, transcriptId: selected.transcriptId }, filming: [] });
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review"]);
  for (const call of f.calls) {
    assert.deepEqual(call.payload.context.candidates, []);
    assert.equal(call.payload.context.cases.length, 1);
    assert.equal(call.payload.context.cases[0].id, selected.referenceId);
    assert.equal(call.payload.context.cases[0].direct, true);
    assert.match(call.payload.context.cases[0].text, /买之前先确认适不适合自己/);
    assert.equal("directCaseSnapshots" in call.payload.context, false, "transaction-only raw snapshots must not enter the model payload");
  }
  assert.deepEqual(f.calls.find(call => call.stage === "draft").payload.plan.choices, []);
  const pack = (await response.json()).version.pack;
  assert.ok(pack.segments.some(segment => segment.caseIds.includes(selected.referenceId)));
  assert.ok(pack.applications.some(application => application.sourceType === "case" && application.sourceId === selected.referenceId && application.used && application.notTransferred));
  assert.doesNotMatch(pack.segments.map(segment => segment.script).join(""), /销量百万|参考作者/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_case_profiles").get().n, 0, "direct selection creates no implicit case profile");
});

test("benchmark mode refuses empty, ambiguous and foreign selections before charging a model call", async t => {
  const f = await ecommerceGenerationFixture(t), foreign = reference(f, "foreign-project");
  setBrief(f, { referenceMode: "benchmark", benchmark: null, caseIds: [] });
  assert.equal((await f.generate()).status, 409);
  setBrief(f, { referenceMode: "benchmark", benchmark: { referenceId: foreign.referenceId, analysisId: foreign.analysisId, transcriptId: foreign.transcriptId }, caseIds: [] });
  assert.equal((await f.generate()).status, 409);
  setBrief(f, { referenceMode: "benchmark", benchmark: { referenceId: foreign.referenceId, analysisId: foreign.analysisId }, caseIds: ["also-selected"] });
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 0);
});

test("benchmark drafts must actually attribute the selected structure and state what was not transferred", async t => {
  const f = await ecommerceGenerationFixture(t, { respond: ({ stage, result }) => {
    if (["draft", "repair"].includes(stage)) {
      for (const segment of result.segments) segment.caseIds = [];
      for (const application of result.applications.filter(item => item.sourceType === "case")) Object.assign(application, { used: false, segmentIds: [], sourceQuote: "", draftQuote: "" });
    }
    return result;
  } }), selected = reference(f);
  setBrief(f, { referenceMode: "benchmark", benchmark: { referenceId: selected.referenceId, analysisId: selected.analysisId, transcriptId: null } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /实际采用所选对标/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n, 0);
});

for (const change of ["reference", "report", "transcript"]) test(`final transaction rejects a late direct benchmark ${change} change`, async t => {
  const f = await ecommerceGenerationFixture(t), selected = reference(f), originalBatch = f.db.batch;
  setBrief(f, { referenceMode: "benchmark", benchmark: { referenceId: selected.referenceId, analysisId: selected.analysisId, transcriptId: selected.transcriptId } });
  let changed = false;
  f.db.batch = async statements => {
    if (!changed && f.calls.length === 3) {
      changed = true;
      if (change === "reference") f.sqlite.prepare("UPDATE project_video_references SET status='revoked' WHERE id=?").run(selected.referenceId);
      if (change === "report") f.sqlite.prepare("UPDATE video_analyses SET report_json=? WHERE id=?").run(JSON.stringify({ changed: "迟到分析版本内容更新" }), selected.analysisId);
      if (change === "transcript") f.sqlite.prepare("UPDATE video_transcripts SET full_text='迟到转写内容更新' WHERE id=?").run(selected.transcriptId);
    }
    return originalBatch(statements);
  };
  const response = await f.generate();
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(changed, true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM ecommerce_tasks WHERE id=?").get(f.task.id).current_version, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM model_calls").get().n, 3, "paid responses remain recorded");
});
