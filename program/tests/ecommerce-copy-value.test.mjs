import assert from "node:assert/strict";
import test from "node:test";
import { ecommerceGenerationFixture } from "./helpers/ecommerce-generation-fixture.mjs";

const courseFacts = {
  content: "课程包含PPT需求拆解和表格整理练习。",
  usage: "学习者先整理一份工作需求，再按示范完成自己的PPT初稿。",
  difference: "从具体工作任务开始，练习后对照示例修改。",
  delivery: "每节配练习任务和可编辑示例文件。",
  limitations: "需要学习者自己完成练习，不提供代做。",
  speakerExperience: "",
};
const editorialCriteria = ["hook", "decision_value", "concrete_detail", "spoken_voice", "method_execution", "action_reason"];

// A deterministic response verifies the API's input/validation boundaries.
// It is not evidence of real-provider writing quality.
function respond({ stage, payload, result }) {
  if (stage === "plan") {
    const methods = payload.generationGuide.copyMethodology.methodCandidates;
    const framework = methods.frameworks[0];
    result.methodSelection = payload.context.task.brief.referenceMode === "benchmark" ? null : {
      hookId: methods.hooks[0].id, frameworkId: framework.id, supplementFrameworkId: "", reason: "用课程实际练习与交付回应只讲概念的顾虑。",
    };
    result.sellingPointFocus = "需要做办公任务的学习者，可以从实际PPT和表格练习判断课程是否可用。";
    result.factPlan = [{ sourceKey: payload.generationGuide.factRegister.find(source => source.sourceId === payload.context.evidence[0].id).sourceKey, sourceQuote: courseFacts.content, buyerMeaning: "具体任务比课程名称更能帮助判断是否值得学习。" }];
    result.outline = result.outline.map((segment, index) => ({ ...segment, methodBeats: result.methodSelection ? index === 1 ? [...framework.beats] : [] : [] }));
  } else if (["draft", "repair"].includes(stage)) {
    const scripts = [
      "AI课别只看入门标签，先看看有没有一项你能动手完成的任务。",
      "这门课先做PPT需求拆解，再练表格整理；每节都配练习任务和可编辑示例文件。你要自己完成练习，课程不提供代做。",
      "想先看练习内容，点击当前视频商品卡查看课程目录，再决定从哪一项任务开始。",
    ];
    result.title = "先看任务，再决定学哪门AI课";
    result.segments.forEach((segment, index) => { segment.script = scripts[index]; });
    for (const application of result.applications) if (application.used) application.draftQuote = result.segments.find(segment => application.segmentIds.includes(segment.id)).script;
  } else if (stage === "review") {
    const segments = payload.draft.segments;
    result.editorialReview = { verdict: "usable", summary: "合成回执仅用于验证具体内容与方法记录的保存契约。", checks: editorialCriteria.map((criterion, index) => ({ criterion, passed: true, segmentIds: [segments[index === 0 ? 0 : index === 5 ? 2 : 1].id], quote: segments[index === 0 ? 0 : index === 5 ? 2 : 1].script, reason: "本项引用实际段落，并以已提供的练习内容、交付与限制作为依据。" })), missingFacts: [] };
  }
  return result;
}

async function courseFixture(t, { rich = false, benchmark = false, extraClaims = false, afterResponse } = {}) {
  const f = await ecommerceGenerationFixture(t, { respond: state => {
    const result = respond(state);
    return afterResponse ? afterResponse({ ...state, result }) : result;
  } });
  const publicData = { ...f.productInput.publicData, category: "课程与知识服务", specification: rich ? "8节录播" : "1", sellingPoints: rich ? "从实际办公任务开始练习" : "便宜", scenarios: "课程学习与练习", audience: { user: "学习提升人群", buyer: "使用者本人" }, claims: [], ...(rich ? { copyFacts: courseFacts } : {}) };
  let product = await f.saveProduct({ name: "AI课程（合成质量测试）", sku: "COPY-VALUE-SYNTHETIC", status: "confirmed", publicData });
  if (extraClaims) {
    // Simulate an unrelated confirmed claim on the same product: it must not
    // make the simple-product path appear to have selected those facts.
    const evidenceResponse = await f.route("evidence").POST(f.request("POST", { productId: product.id, title: "未选课程资料", kind: "specification", body: `${courseFacts.content}\n${courseFacts.delivery}`, sourceLocator: "合成资料，仅供测试", status: "confirmed" }));
    assert.equal(evidenceResponse.status, 201, await evidenceResponse.clone().text());
    const evidenceId = (await evidenceResponse.json()).evidence.id;
    product = await f.saveProduct({ id: product.id, revision: 1, name: "AI课程（合成质量测试）", sku: "COPY-VALUE-SYNTHETIC", status: "confirmed", publicData: { ...publicData, claims: [{ id: "unselected-detailed-claim", kind: "specification", statement: courseFacts.content, allowedExpression: `${courseFacts.content}\n${courseFacts.delivery}`, conditions: "", evidenceIds: [evidenceId], validUntil: null, status: "confirmed" }] } });
  }
  f.sqlite.prepare("DELETE FROM ecommerce_component_versions").run();
  f.sqlite.prepare("DELETE FROM ecommerce_components").run();
  const brief = { ...f.brief, referenceMode: benchmark ? "benchmark" : "method", benchmark: null, caseIds: [], componentIds: [], claimId: "", evidenceIds: [], filming: [], audience: { user: "学习提升人群", buyer: "使用者本人" }, scene: "课程学习与练习", barrier: "担心只有概念，没有实际练习", durationSec: 30 };
  if (benchmark) {
    const videoId = f.seed("videos", { title: "外部课程参考", platform: "douyin", source_type: "url", status: "ready" });
    const libraryId = f.seed("video_library_entries", { source_video_id: videoId, category: "benchmark" });
    const referenceId = f.seed("project_video_references", { library_entry_id: libraryId, purpose: "benchmark", status: "active" });
    const analysisId = f.seed("video_analyses", { video_id: videoId, schema_version: "test", report_json: JSON.stringify({ structure: "先提问题，再展示练习，最后行动。", originalFacts: "原作者试过七八门课程，第一节教PPT，另含一百份模板。" }) });
    brief.benchmark = { referenceId, analysisId, transcriptId: null };
  }
  const created = await f.route("tasks").POST(f.request("POST", { title: "课程文案内容价值测试", productId: product.id, productVersionId: product.versionId, brief }));
  assert.equal(created.status, 201, await created.clone().text());
  const task = (await created.json()).task, params = { params: Promise.resolve({ taskId: task.id }) };
  const recommendations = () => f.route("tasks/[taskId]/recommendations").GET(f.request("GET"), params);
  const generate = () => f.route("tasks/[taskId]/generate").POST(f.request("POST", { revision: 1, baseVersion: 0, idempotencyKey: "copy-value" }), params);
  return { ...f, product, task, recommendations, generate };
}

test("sparse course material returns actionable gaps and refuses generation before any model call", async t => {
  const f = await courseFixture(t);
  const response = await f.recommendations();
  assert.equal(response.status, 200);
  const recommendation = await response.json();
  assert.equal(recommendation.ready, false);
  assert.equal(recommendation.copyReadiness.ready, false);
  assert.deepEqual(recommendation.copyReadiness.missing.map(gap => gap.field), ["content", "usage"]);
  assert.ok(recommendation.copyReadiness.missing.every(gap => gap.label && gap.reason && gap.example));
  const generated = await f.generate();
  assert.equal(generated.status, 409);
  assert.equal((await generated.json()).error.code, "TASK_INCOMPLETE");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_generation_runs").get().n, 0);
});

test("actual course content, tasks, delivery and limits reach every generation stage as owned facts", async t => {
  const f = await courseFixture(t, { rich: true });
  const recommendation = await (await f.recommendations()).json();
  assert.equal(recommendation.copyReadiness.ready, true);
  const response = await f.generate();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review"]);
  for (const call of f.calls) {
    assert.deepEqual(call.payload.context.product.copyFacts, courseFacts);
    assert.ok(call.payload.context.evidence[0].body.includes(courseFacts.content));
    assert.ok(call.payload.context.evidence[0].body.includes(courseFacts.delivery));
    assert.ok(call.payload.context.evidence[0].body.includes(courseFacts.limitations));
    assert.equal(call.payload.context.product.copyFacts.speakerExperience, "");
    assert.doesNotMatch(JSON.stringify(call.payload), /PRIVATE_TEST_ONLY|PRIVATE_REFUNDS/);
  }
  const version = f.sqlite.prepare("SELECT input_snapshot_json,validation_json FROM ecommerce_versions WHERE task_id=?").get(f.task.id);
  const snapshot = JSON.parse(version.input_snapshot_json);
  assert.deepEqual(snapshot.product.copyFacts, courseFacts);
  assert.ok(snapshot.plan.factPlan.length);
  assert.equal(JSON.parse(version.validation_json).review.editorialReview.verdict, "usable");
});

test("a reference's detailed course claims cannot fill missing facts about our sparse course", async t => {
  const f = await courseFixture(t, { benchmark: true });
  const recommendation = await (await f.recommendations()).json();
  assert.equal(recommendation.cases.length, 1);
  assert.match(recommendation.cases[0].text, /一百份模板/);
  assert.equal(recommendation.copyReadiness.ready, false);
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal(f.calls.length, 0);
});

test("unselected claims cannot make sparse simple-product inputs appear ready", async t => {
  const f = await courseFixture(t, { extraClaims: true });
  const recommendation = await (await f.recommendations()).json();
  assert.equal(recommendation.copyReadiness.ready, false);
  assert.equal((await f.generate()).status, 409);
  assert.equal(f.calls.length, 0);
});

test("all-true legacy quality flags do not override a failed editorial verdict", async t => {
  const f = await courseFixture(t, { rich: true, afterResponse: ({ stage, result }) => {
    if (stage === "review") result.editorialReview = { ...result.editorialReview, verdict: "needs_rewrite", summary: "正文虽然有资料依据，但没有给出清楚的购买判断。" };
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "REVIEW_REJECTED");
  assert.deepEqual(f.calls.map(call => call.stage), ["plan", "draft", "review", "repair", "review"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
});

test("editorial praise targeting an unknown paragraph cannot pass acceptance", async t => {
  const f = await courseFixture(t, { rich: true, afterResponse: ({ stage, result }) => {
    if (stage === "review") result.editorialReview.checks[0].segmentIds = ["unknown-paragraph"];
    return result;
  } });
  const response = await f.generate();
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /内容价值检查缺少可定位的正文依据/);
  assert.equal(f.calls.filter(call => call.stage === "repair").length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM ecommerce_versions WHERE task_id=?").get(f.task.id).n, 0);
});
