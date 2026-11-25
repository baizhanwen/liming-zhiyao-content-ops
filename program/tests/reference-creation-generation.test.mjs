import assert from "node:assert/strict";
import test from "node:test";
import { alignReferenceCreation, applyReferenceEndingRules } from "../lib/structure-creation.ts";
import { parseModelJson } from "../lib/content-production.ts";
import { readReferenceMaterialQuestions } from "../lib/reference-material-questions.ts";
import { fixture as singleBenchmarkFixture } from "./helpers/single-benchmark-fixture.mjs";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

const sourceScript = "开场要讲一个学生能碰到的真实学习问题。\n接下来分清不同任务各自该找哪一种资料。\n对照刚讲的方法找到适合自己的那种资料。";
const emptyDelivery = { spokenText: "", screenText: "", originalSound: "", table: null };
const progressId = "1234567890abcdef1234567890abcdef";

function progressReader(f) {
  const { GET } = f.load("app/api/content-items/[contentId]/generation-progress/route.ts");
  const scope = f.sqlite.prepare("SELECT organization_id AS organizationId, project_id AS projectId FROM content_items WHERE id=?").get(f.contentId);
  return (options = {}, contentId = f.contentId) => GET(new Request("http://localhost/progress?" +
    new URLSearchParams({ ...scope, expectedVersion: "1", ...options })), { params: Promise.resolve({ contentId }) });
}

async function referenceFixture(t, afterDraft, respond, review) {
  const calls = [], reviewCalls = [];
  const f = await contentGenerationFixture(t, ["chosen"], (input, _, base) => {
    const prompt = parseModelJson(input.user.slice(input.user.indexOf("\n") + 1));
    if (prompt.companionTexts) {
      reviewCalls.push(prompt);
      return review ? review(prompt) : { revisions: [] };
    }
    calls.push(prompt);
    const { segments } = prompt.referenceCreation;
    const selected = segments[0].materialIds[0];
    const quote = selected + "品牌案例中实际发生的真实实验过程与结果。";
    const result = { writingIntent: base.writingIntent, fullScript: "这段模型自由发挥的正文不应覆盖已确认行。", shortScript: segments[0].note,
      referenceSegments: [
        { ...emptyDelivery, segmentId: segments[0].segmentId, spokenText: segments[0].note },
        { ...emptyDelivery, segmentId: segments[1].segmentId, originalSound: "翻动书页的声音" },
        { ...emptyDelivery, segmentId: segments[2].segmentId, table: { columns: ["情况", "方法"], rows: [[segments[0].note, selected]] } },
      ],
      citations: [{ sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" },
        { sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张" },
        { sourceType: "video_analysis", sourceId: "analysis", quote: sourceScript.split("\n")[0] },
        { sourceType: "knowledge", sourceId: selected, quote }],
    };
    result.storyboard = segments.map(({ segmentId }, index) => ({
      segmentId, shot: String(index + 1), script: "", visual: "展示本段的资料", performance: "给画面留出阅读时间", durationSec: 5,
    }));
    result.citations = result.citations.filter(c => c.sourceType === "knowledge").map(c => ({ sourceAnchorId: prompt.referenceCitationOptions.find(option => option.sourceType === c.sourceType && option.sourceId === c.sourceId).sourceAnchorId }));
    afterDraft?.(f);
    return respond ? respond(prompt, result) : result;
  });
  f.seed("videos", { id: "video", platform: "douyin", source_type: "url", title: "复习资料怎么选" });
  f.seed("video_analyses", { id: "analysis", video_id: "video", schema_version: "1", report_json: JSON.stringify({ spoken_script_set: { corrected_original: { status: "completed", text: sourceScript } } }) });
  f.sqlite.prepare("UPDATE topic_ideas SET source_type='video_analysis', source_ref='video', angle='过期材料的保密内容', rationale='不应该再出现在这次生成的旧事实' WHERE id=?").run(f.topicId);
  f.seed("topic_citations", { topic_id: f.topicId, citation_type: "video_analysis", citation_id: "analysis", quote: "过期的选题材料也不得进入生成" });
  const input = { videoId: "video", analysisId: "analysis", topicMode: "reference", segments: [
    { segmentId: "part-1", note: "先把课件截图逐页核对。", materialIds: ["chosen"], presentation: "spoken" },
    { segmentId: "part-2", note: "收录的翻书声。", materialIds: [], presentation: "original_sound" },
    { segmentId: "part-3", note: "上屏展示一份汇总表。", materialIds: [], presentation: "screen_table" },
  ] };
  return { ...f, calls, reviewCalls, input, generate: (referenceCreation, expectedVersion = 1) => f.complete([], { creationMode: "single_benchmark", expectedVersion, referenceCreation }) };
}

test("按本次提交读取真实生成和复核进度，只返回当前空间指定版本的状态", async t => {
  const f = await referenceFixture(t);
  const getProgress = progressReader(f);
  const observations = [];
  const adapter = f.load("lib/model-adapter.ts");
  const invoke = adapter.invokeContentModel;
  adapter.invokeContentModel = async (...args) => {
    const explicit = await (await getProgress({ generationRequestId: progressId })).json();
    observations.push(explicit.progress);
    assert.deepEqual(await (await getProgress()).json(), explicit);
    assert.deepEqual(await (await getProgress({ generationRequestId: "b".repeat(32) })).json(), { progress: null });
    return invoke(...args);
  };
  const response = await f.complete([], { creationMode: "single_benchmark", expectedVersion: 1, generationRequestId: progressId,
    referenceCreation: { ...f.input, focus: "讲清核对的先后顺序" } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(observations.map(run => [run.status, run.stage, run.requestCount]), [["running", "writing", 1], ["running", "reviewing", 2]]);
  const snapshot = await getProgress({ generationRequestId: progressId });
  assert.match(snapshot.headers.get("Cache-Control"), /no-store/);
  const { progress } = await snapshot.json();
  assert.equal(progress.status, "completed");
  assert.equal(progress.stage, "saving");
  assert.equal(progress.expectedVersion, 1);
  assert.deepEqual(progress.materialQuestions, []);
  assert.ok(Date.parse(progress.finishedAt) >= Date.parse(progress.startedAt));
  assert.deepEqual(Object.keys(progress).sort(), ["generationRequestId","expectedVersion","status","stage","startedAt","stepStartedAt","finishedAt","requestCount","errorCode","materialQuestions"].sort());
  assert.deepEqual(await (await getProgress()).json(), { progress: null });
  assert.deepEqual(await (await getProgress({ generationRequestId: progressId, expectedVersion: "2" })).json(), { progress: null });
  assert.deepEqual(await (await getProgress({ generationRequestId: progressId }, "another-content")).json(), { progress: null });
  assert.equal((await getProgress({ generationRequestId: progressId, projectId: "other" })).status, 403);
  assert.equal((await getProgress({ expectedVersion: "bad" })).status, 400);
});

test("从灵感写稿固定首版来源，两种选题共享结构且模型只收到选中的标题", async t => {
  const f = await referenceFixture(t);
  const picked = { ...f.input, topicMode: "custom", customTopic: "从一次复习说起", idea: { kind: "card", id: "idea-on-first-version" } };
  f.sqlite.prepare("UPDATE content_versions SET pack_json=json_set(pack_json,'$.referenceCreation',json(?)) WHERE content_item_id=? AND version=1").run(JSON.stringify(picked), f.contentId);
  for (const changed of [f.input, { ...picked, idea: undefined }, { ...picked, customTopic: "临时另一题" }, { ...picked, idea: { kind: "card", id: "swapped" } }]) {
    const response = await f.generate(changed);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "REFERENCE_TOPIC_CHANGED");
  }
  assert.equal(f.calls.length, 0);
  const saved = await f.generate(picked);
  assert.equal(saved.status, 200, await saved.clone().text());
  const pack = JSON.parse((await saved.json()).item.pack_json);
  assert.deepEqual(pack.referenceCreation.idea, picked.idea);
  assert.equal(f.calls[0].referenceCreation.topic, picked.customTopic);
  assert.ok(!JSON.stringify(f.calls[0]).includes(picked.idea.id));
});

test("从选参考到生成稿件：沿用、手填、选灵感共用一份骨架，只有主动保存的想法出现在库中", async t => {
  const f = await referenceFixture(t);
  const create = f.load("app/api/videos/[videoId]/structure-draft/route.ts");
  const generate = f.load("app/api/content-items/[contentId]/generate/route.ts");
  const list = f.load("app/api/studio/ideas/route.ts");
  const org = f.sqlite.prepare("SELECT organization_id FROM projects WHERE id='project'").get().organization_id;
  const library = async () => {
    const response = await list.GET(new Request("http://localhost/api/studio/ideas?" + new URLSearchParams({ organizationId: org, projectId: "project" })));
    assert.equal(response.status, 200);
    return (await response.json()).ideas.map(({kind,id}) => kind+":"+id).sort();
  };
  f.seed("project_inspiration_cards", { id:"picked-idea", title:"怎样检查学习笔记的来源", core_insight:"灵感中的未核实推测", canonical_key:"saved-card", source_type:"manual", content_hash:"hash" });
  const before = await library();
  assert.ok(before.includes("card:picked-idea"));
  const inputs = [f.input, { ...f.input, topicMode:"custom", customTopic:"挑复习材料的第一步" },
    { ...f.input, topicMode:"custom", customTopic:"怎样检查学习笔记的来源", idea:{ kind:"card", id:"picked-idea" } }];
  for (const [i, referenceCreation] of inputs.entries()) {
    const created = await create.POST(f.request({requestId:"flow-"+i, referenceCreation}), { params: Promise.resolve({videoId:"video"}) });
    assert.equal(created.status, 201, await created.clone().text());
    const {contentId} = await created.json();
    const response = await generate.POST(f.request({creationMode:"single_benchmark", expectedVersion:1, referenceCreation}), {params:Promise.resolve({contentId})});
    assert.equal(response.status, 200, await response.clone().text());
    const item = (await response.json()).item;
    const report = JSON.parse(item.pack_json).referenceCreation;
    assert.equal(item.current_version, 2);
    assert.equal(report.topic, referenceCreation.customTopic ?? "复习资料怎么选");
    assert.deepEqual(report.idea, referenceCreation.idea);
    assert.deepEqual(report.segments.map(s=>s.segmentId), f.input.segments.map(s=>s.segmentId));
  }
  assert.deepEqual(await library(), before);
  assert.ok(!JSON.stringify(f.calls).includes("灵感中的未核实推测"));
  const search = f.load("app/api/search/route.ts");
  const find = async query => {
    const response = await search.GET(new Request("http://localhost/api/search?" + new URLSearchParams({organizationId:org, q:query})));
    assert.equal(response.status, 200);
    return (await response.json()).results.map(({type})=>type).sort();
  };
  assert.deepEqual(await find("挑复习材料的第一步"), ["content"]);
  assert.deepEqual(await find("怎样检查学习笔记的来源"), ["card", "content"]);
});

test("参考创作缺少必要事实时按段追问一次，补充该段后继续生成已有稿件", async t => {
  const questions = [{ segmentId: "part-1", question: "这一步在什么情况下做了什么调整？" }];
  const missing = "希望讲清楚这次实际调整的方法。";
  const f = await referenceFixture(t, null, (prompt, result) =>
    prompt.referenceCreation.segments[0].note === missing ? { materialQuestions: questions } : result);
  f.input.segments[0].note = missing;
  const item = () => f.sqlite.prepare("SELECT current_version,status FROM content_items WHERE id=?").get(f.contentId);
  const versions = () => f.sqlite.prepare("SELECT COUNT(*) AS total FROM content_versions WHERE content_item_id=?").get(f.contentId).total;
  const before = item(), beforeVersions = versions();
  const response = await f.generate(f.input);
  assert.equal(response.status, 422, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, "REFERENCE_MATERIAL_NEEDED");
  assert.deepEqual(body.materialQuestions, questions);
  assert.equal(body.item, undefined);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(item(), before);
  assert.equal(versions(), beforeVersions);
  const call = f.sqlite.prepare("SELECT status,output_json FROM model_calls WHERE topic_id=?").get(f.topicId);
  assert.equal(call.status, "completed");
  const saved = JSON.parse(call.output_json);
  assert.equal(saved.outcome, "material_questions");
  assert.equal(saved.modelRequests.length, 1);
  assert.equal(saved.modelRequests[0].status, "completed");
  f.input.segments[0].note = "实际把两份记录并排列好，再逐行核对改动。";
  const completed = await f.generate(f.input);
  assert.equal(completed.status, 200, await completed.clone().text());
  const pack = JSON.parse((await completed.json()).item.pack_json);
  assert.equal(pack.referenceCreation.segments[0].spokenText, f.input.segments[0].note);
  assert.equal(versions(), beforeVersions + 1);
  assert.equal(f.calls.length, 2);
});

test("材料追问只接受已确认段落、每段一问，并且与生产包互斥", () => {
  const segments = [{ segmentId: "opening" }, { segmentId: "change" }];
  const first = { segmentId: "opening", question: "请补充当时的一个可公开细节。" };
  const second = { segmentId: "change", question: "调整前后，各是什么做法？" };
  assert.deepEqual(readReferenceMaterialQuestions({ materialQuestions: [second, first] }, segments), [first, second]);
  assert.equal(readReferenceMaterialQuestions({ referenceSegments: [] }, segments), null);
  for (const rows of [[], [first, first], [{ ...first, segmentId: "unconfirmed" }], [{ ...second, question: " " }]])
    assert.throws(() => readReferenceMaterialQuestions({ materialQuestions: rows }, segments));
  assert.throws(() => readReferenceMaterialQuestions({ materialQuestions: [first], referenceSegments: [] }, segments));
});

test("沿用选题、自拟选题与换料重生成只使用当次确认，保存真实字幕表及原声", async t => {
  const f = await referenceFixture(t);
  for (let i = 0; i < 3; i++) {
    const input = structuredClone(f.input);
    if (i) { input.topicMode = "custom"; input.customTopic = "如何核对不同版本的期末资料"; }
    if (i === 2) {
      input.focus = "强调样题出处";
      input.segments[0].materialIds = ["unselected"];
      input.segments[0].note = "打开这次老师发布的样题。";
    }
    const response = await f.generate(input, i + 1);
    assert.equal(response.status, 200, await response.clone().text());
    const pack = JSON.parse((await response.json()).item.pack_json), delivery = pack.referenceCreation;
    assert.equal(delivery.topic, input.customTopic || "复习资料怎么选");
    assert.deepEqual(delivery.productionBasis.map(item => item.sourceType), ["strategy", "method_knowledge", "video_analysis"]);
    assert.ok(delivery.productionBasis.every(item => item.purpose && item.quote.length >= 8));
    assert.equal(pack.qualityReview, undefined);
    assert.equal(pack.benchmarkMethods?.length ?? 0, 0);
    assert.deepEqual(pack.storyboard.map(shot => shot.segmentId), input.segments.map(segment => segment.segmentId));
    assert.equal(delivery.segments[0].spokenText, input.segments[0].note);
    assert.equal(delivery.segments[1].spokenText, "");
    assert.equal(delivery.segments[1].originalSound, "翻动书页的声音");
    assert.deepEqual(delivery.segments[2].table.rows, [[input.segments[0].note, input.segments[0].materialIds[0]]]);
    assert.ok(pack.fullScript.includes(input.segments[0].note));
    assert.ok(!pack.fullScript.includes("自由发挥"));
    assert.doesNotMatch(f.calls.at(-1).contextLayers.projectFacts, /video_analysis/);
    assert.match(f.calls.at(-1).contextLayers.referenceExamples, /video_analysis/);
    const actual = JSON.stringify(f.calls.at(-1));
    assert.doesNotMatch(actual, /过期材料|旧事实|过期的选题材料|foreign品牌/);
    if (i === 2) {
      assert.doesNotMatch(actual, /chosen品牌|课件截图/);
      assert.doesNotMatch(JSON.stringify(pack), /chosen品牌|课件截图/);
    } else assert.doesNotMatch(actual, /unselected品牌/);
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.reviewCalls.length, 1);
  const schema = f.calls[0].outputSchema.oneOf.find(schema => schema.properties.referenceSegments);
  assert.deepEqual(Object.keys(schema.properties).sort(), ["citations", "fullScript", "referenceSegments", "shortScript", "storyboard", "writingIntent"]);
  assert.ok(schema.properties.storyboard.items.required.includes("segmentId"));
  assert.ok(f.reviewCalls[0].companionTexts.every(row => row.fieldId === "shortScript" || row.fieldId.startsWith("storyboard.")));
  const old = await f.generate(f.input, 1);
  assert.equal(old.status, 409);
  const persisted = f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=4").get(f.contentId);
  const pack = JSON.parse(persisted.pack_json);
  assert.equal(pack.referenceCreation.topicMode, "custom");
  const savedTable = structuredClone(pack.referenceCreation.segments[2].table);
  const save = f.load("app/api/content-items/[contentId]/route.ts");
  const patch = body => save.PATCH(f.request({ pack: body, expectedVersion: 4 }), { params: Promise.resolve({ contentId: f.contentId }) });
  const injected = structuredClone(pack);
  injected.citations.push({ sourceType: "knowledge", sourceId: "chosen", quote: "chosen品牌案例中实际发生的真实实验过程与结果。" });
  const blocked = await patch(injected);
  assert.equal(blocked.status, 409);
  pack.referenceCreation.focus = "客户端伪造的已生成重点";
  pack.referenceCreation.segments[2].table.rows[0][0] = "客户端伪造的表格内容";
  pack.fullScript += "\n\n把样题编号和课堂记录再对一次。";
  const edited = await patch(pack);
  assert.equal(edited.status, 200, await edited.clone().text());
  const savedItem = (await edited.json()).item;
  const manual = JSON.parse(savedItem.pack_json);
  assert.equal(manual.referenceCreation.scriptEdited, true);
  assert.equal(manual.referenceCreation.focus, "强调样题出处");
  assert.deepEqual(manual.referenceCreation.segments[2].table, savedTable);
  const citations = f.sqlite.prepare("SELECT citation_type,citation_id FROM content_citations WHERE content_version_id=?").all(savedItem.version_id);
  assert.ok(citations.some(c => c.citation_type === "video_analysis" && c.citation_id === "analysis"));
  assert.ok(citations.some(c => c.citation_type === "knowledge" && c.citation_id === "unselected"));
  assert.ok(!citations.some(c => c.citation_type === "knowledge" && c.citation_id === "chosen"));
});

test("全篇重点可以修改或清空；两种选题模式只在写作指示中携带重点并保留逐段材料", async t => {
  const f = await referenceFixture(t);
  const first = "把注意力放在核对来源上", second = "把注意力放在材料的先后顺序上";
  const cases = [
    { topicMode: "reference", focus: "  " + first + "  " },
    { topicMode: "reference", focus: second },
    { topicMode: "custom", customTopic: "选择资料时怎样判断顺序", focus: second },
    { topicMode: "custom", customTopic: "选择资料时怎样判断顺序", focus: "  " },
  ];
  const hashes = [];
  for (const [i, config] of cases.entries()) {
    const response = await f.generate({ ...f.input, ...config }, i + 1);
    assert.equal(response.status, 200, await response.clone().text());
    const focus = config.focus.trim() || undefined;
    const prompt = f.calls.at(-1);
    const { focus: sentFocus, ...reference } = prompt.referenceCreation;
    assert.equal(sentFocus, focus);
    assert.equal(reference.topic, config.customTopic || "复习资料怎么选");
    assert.equal(reference.topicMode, config.topicMode);
    assert.deepEqual(reference.segments.map(({ segmentId, materialIds, presentation, note }) => ({ segmentId, materialIds, presentation, note })), f.input.segments);
    const otherPromptData = JSON.stringify({ ...prompt, referenceCreation: reference });
    assert.ok(!otherPromptData.includes(first) && !otherPromptData.includes(second));
    const saved = f.sqlite.prepare("SELECT pack_json, input_snapshot_json, input_snapshot_hash FROM content_versions WHERE content_item_id=? AND version=?").get(f.contentId, i + 2);
    assert.equal(JSON.parse(saved.pack_json).referenceCreation.focus, focus);
    assert.equal(JSON.parse(saved.input_snapshot_json).referenceCreation.hasFocus, Boolean(focus));
    assert.ok(!saved.input_snapshot_json.includes(first) && !saved.input_snapshot_json.includes(second));
    hashes.push(saved.input_snapshot_hash);
  }
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(f.calls.length, 4);
  assert.equal(f.reviewCalls.length, 3);
  assert.equal((await f.generate({ ...f.input, focus: "重".repeat(301) }, 5)).status, 400);
  assert.equal(f.calls.length, 4);
});

test("有重点的参考稿在同一次复核中定向修订，保持未改镜头，保存一致正文、短版和可追溯引用", async t => {
  const fabricated = "我忽然觉得自己辜负了大家。";
  const supported = "计划表里圈出了要核对的一页。";
  const f = await referenceFixture(t, null, (_prompt, pack) => {
    pack.referenceSegments[0].spokenText = fabricated;
    pack.shortScript = "那一刻我觉得对不起所有人。";
    pack.storyboard[0].script = fabricated;
    return pack;
  }, review => {
    assert.equal(review.focus, "重点写核对资料时的动作。");
    assert.equal(review.segments[0].draft.spokenText, fabricated);
    assert.deepEqual(review.materials.map(row => row.sourceId), ["chosen"]);
    assert.doesNotMatch(JSON.stringify(review), /foreign品牌|过期材料|PRIVATE_PERSONA/);
    const short = review.companionTexts.find(row => row.fieldId === "shortScript");
    assert.equal(short.text, "那一刻我觉得对不起所有人。");
    return { revisions: [{ ...emptyDelivery, segmentId: "part-1", spokenText: supported,
      reason: "改用实际看得到的计划表细节。", evidence: [{ sourceId: "note:part-1", quote: supported }] }],
      companionEdits: [{ fieldId: "shortScript", text: supported }, { fieldId: "storyboard.0.script", text: supported }] };
  });
  f.input.focus = "重点写核对资料时的动作。";
  f.input.segments[0].note = supported;
  const res = await f.generate(f.input);
  assert.equal(res.status, 200, await res.clone().text());
  const { item } = await res.json(), pack = JSON.parse(item.pack_json);
  assert.match(item.full_script, new RegExp(supported));
  assert.equal(pack.referenceCreation.segments[0].spokenText, supported);
  assert.equal(pack.referenceCreation.segments[1].originalSound, "翻动书页的声音");
  assert.equal(item.short_script, supported);
  assert.equal(pack.storyboard[0].script, supported);
  assert.ok(!pack.citations.some(row => row.sourceId === "chosen"));
  assert.ok(pack.citations.some(row => row.sourceId === "analysis"));
  assert.doesNotMatch(JSON.stringify(pack), /辜负|对不起所有人/);
  const run = JSON.parse(f.sqlite.prepare("SELECT output_json FROM model_calls WHERE id=?").get(item.model_call_id).output_json);
  assert.deepEqual(run.modelRequests.map(row => row.step), ["generation", "reference_draft_review"]);
  assert.deepEqual(run.referenceReview.revisedSegmentIds, ["part-1"]);
});

test("复核追问或无效修订时不写新版本，也不自动重走生成", async t => {
  for (const invalid of [false, true]) {
    const questions = [{ segmentId: "part-1", question: "当天实际核对了哪一页？" }];
    const fakeEvidence = { revisions: [{ ...emptyDelivery, segmentId: "part-1", spokenText: "这句没有对应证据。",
      reason: "补一句话。", evidence: [{ sourceId: "unselected", quote: "不属于本段" }] }] };
    const f = await referenceFixture(t, null, null, () => invalid ? fakeEvidence : { materialQuestions: questions });
    const response = await f.complete([], { expectedVersion: 1, generationRequestId: progressId, creationMode: "single_benchmark",
      referenceCreation: { ...f.input, focus: "讲清当天实际核对的页码" } });
    const body = await response.json();
    assert.equal(response.status, invalid ? 502 : 422, JSON.stringify(body));
    assert.equal(body.error.code, invalid ? "REFERENCE_REVIEW_INVALID" : "REFERENCE_MATERIAL_NEEDED");
    if (!invalid) assert.deepEqual(body.materialQuestions, questions);
    const { progress } = await (await progressReader(f)({ generationRequestId: progressId })).json();
    assert.equal(progress.status, invalid ? "failed" : "needs_material");
    assert.equal(progress.errorCode, invalid ? "REFERENCE_REVIEW_INVALID" : null);
    assert.deepEqual(progress.materialQuestions, invalid ? [] : questions);
    assert.equal(f.calls.length, 1);
    assert.equal(f.reviewCalls.length, 1);
    assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
  }
});

test("修订改用本段另一条已选资料时，已保存版本和采用来源同时切换", async t => {
  const f = await referenceFixture(t, null, null, () => ({
    revisions: [{ ...emptyDelivery, segmentId: "part-1", spokenText: "这一段展示实验记录中的过程。", reason: "改用本段已选的另一份实验材料。",
      evidence: [{ sourceId: "unselected", quote: "实验过程" }] }],
  }));
  f.input.segments[0].materialIds.push("unselected");
  const response = await f.generate({ ...f.input, focus: "按实验材料讲清楚过程。" });
  assert.equal(response.status, 200, await response.clone().text());
  const { item } = await response.json(), pack = JSON.parse(item.pack_json);
  const used = pack.citations.filter(row => row.sourceType === "knowledge");
  assert.deepEqual(used.map(row => row.sourceId), ["unselected"]);
  assert.match(used[0].quote, /实验过程/);
  assert.deepEqual(pack.sourceUsageReport.groups.find(group => group.key === "selected_knowledge").citedSourceIds, ["unselected"]);
  const stored = f.sqlite.prepare("SELECT citation_id FROM content_citations WHERE content_version_id=? AND citation_type='knowledge'").all(item.version_id);
  assert.deepEqual(stored.map(row => row.citation_id), ["unselected"]);
});

test("复核通过时也会把分镜里的整段重复旁白留作续接画面", async t => {
  const f = await referenceFixture(t, null, (_prompt, pack) => {
    const shot = pack.storyboard[0], line = pack.referenceSegments[0].spokenText;
    pack.storyboard.splice(0, 1, { ...shot, script: line }, { ...shot, script: line, visual: "镜头继续展示资料" });
    return pack;
  });
  const response = await f.generate({ ...f.input, focus: "重点给观众看核对的动作。" });
  assert.equal(response.status, 200, await response.clone().text());
  const pack = JSON.parse((await response.json()).item.pack_json);
  assert.deepEqual(pack.storyboard.slice(0, 2).map(shot => shot.script), [f.input.segments[0].note, ""]);
  assert.deepEqual(pack.storyboard.map(shot => shot.segmentId), ["part-1", "part-1", "part-2", "part-3"]);
  assert.equal(pack.storyboard[1].visual, "镜头继续展示资料");
  assert.equal(f.reviewCalls.length, 1);
});

test("复核期间当前素材被撤销时，审过的稿件也不覆盖已有版本", async t => {
  const f = await referenceFixture(t, null, null, () => {
    f.sqlite.prepare("UPDATE knowledge_items SET status='draft' WHERE id='chosen'").run();
    return { revisions: [] };
  });
  const response = await f.generate({ ...f.input, focus: "只采用可以核对的资料。" });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.calls.length, 1);
  assert.equal(f.reviewCalls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
});

test("参考新稿拒绝归属缺失、未知、缺段或顺序错乱的分镜，生成失败保留旧版本", async t => {
  for (const invalid of [
    shots => { delete shots[0].segmentId; },
    shots => { shots[0].segmentId = "outside-this-reference"; },
    shots => { shots[1].segmentId = shots[0].segmentId; },
    shots => { shots.push({ ...shots[0], shot: "末镜" }); },
  ]) {
    const f = await referenceFixture(t, null, (_prompt, result) => {
      invalid(result.storyboard);
      return result;
    });
    const response = await f.generate(f.input);
    assert.equal(response.status, 502, await response.clone().text());
    const { error } = await response.json();
    assert.equal(error.code, "REFERENCE_DELIVERY_INVALID");
    assert.match(error.message, /分镜|segmentId/);
    assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS total FROM content_versions WHERE content_item_id=?").get(f.contentId).total, 1);
  }
});

test("已有参考稿的分镜缺少段落 ID 时仍可读取并手动保存", async t => {
  const f = await referenceFixture(t);
  const response = await f.generate(f.input);
  assert.equal(response.status, 200, await response.clone().text());
  const { item } = await response.json(), legacyPack = JSON.parse(item.pack_json);
  for (const shot of legacyPack.storyboard) delete shot.segmentId;
  f.sqlite.prepare("UPDATE content_versions SET pack_json=? WHERE id=?").run(JSON.stringify(legacyPack), item.version_id);
  const scope = f.sqlite.prepare("SELECT organization_id AS organizationId, project_id AS projectId FROM content_items WHERE id=?").get(f.contentId);
  const list = await f.load("app/api/content-items/route.ts").GET(new Request("http://localhost/api/content-items?" + new URLSearchParams(scope)));
  assert.equal(list.status, 200);
  const loaded = JSON.parse((await list.json()).items.find(row => row.id === f.contentId).pack_json);
  assert.deepEqual(loaded.storyboard, legacyPack.storyboard);
  loaded.fullScript += "\n这一步再对照课件核对一次。";
  const save = await f.load("app/api/content-items/[contentId]/route.ts").PATCH(
    f.request({ pack: loaded, expectedVersion: item.current_version }), { params: Promise.resolve({ contentId: f.contentId }) });
  assert.equal(save.status, 200, await save.clone().text());
  assert.deepEqual(JSON.parse((await save.json()).item.pack_json).storyboard, legacyPack.storyboard);
});

test("复核材料摘录带标点的原始长度超过 80 时按实际原文截取", async t => {
  const quote = "看，听。".repeat(24);
  const f = await referenceFixture(t, null, null, () => ({
    revisions: [{ ...emptyDelivery, segmentId: "part-1", spokenText: "材料写着重复的动作提示。", reason: "只采用该材料原文。",
      evidence: [{ sourceId: "unselected", quote }] }],
  }));
  f.sqlite.prepare("UPDATE knowledge_item_versions SET body=? WHERE item_id='unselected'").run(quote);
  f.input.segments[0].materialIds.push("unselected");
  const response = await f.generate({ ...f.input, focus: "给出材料中的动作提示。" });
  assert.equal(response.status, 200, await response.clone().text());
  const pack = JSON.parse((await response.json()).item.pack_json);
  assert.equal(pack.citations.find(row => row.sourceId === "unselected").quote, quote.slice(0, 80));
});

test("缺段、错稿源、其他空间资料均在付费请求前被拒绝", async t => {
  const f = await referenceFixture(t);
  for (const modify of [s => s.segments.pop(), s => {s.videoId = "other-video";}, s => {s.segments[0].materialIds = ["foreign"];}]) {
    const input = structuredClone(f.input);
    modify(input);
    assert.equal((await f.generate(input)).status, 409);
  }
  assert.equal(f.calls.length, 0);
});

test("按用户指定呈现方式保留必须字段，忽略附赠内容，拒绝缺失原声或残缺上屏表", () => {
  const input = { videoId: "video", analysisId: "analysis", topicMode: "reference", segments: [{ segmentId: "part-1", note: "", materialIds: [], presentation: "screen_table" }] };
  const role = new Map([["part-1", "展示汇总表"]]);
  const row = { ...emptyDelivery, segmentId: "part-1", table: { columns: ["第一列", "第二列"], rows: [["课件"]] } };
  assert.throws(() => alignReferenceCreation(input, "复习", role, [row]));
  input.segments[0].presentation = "original_sound";
  const extra = { segmentId: "part-1", originalSound: "翻页声", spokenText: "额外的口播", screenText: "额外的字幕", table: { malformed: true } };
  const original = alignReferenceCreation(input, "复习", role, [extra]).segments[0];
  assert.equal(original.originalSound, "翻页声");
  assert.equal(original.spokenText, "");
  assert.equal(original.table, null);
  assert.throws(() => alignReferenceCreation(input, "复习", role, [{ ...extra, originalSound: null }]), /originalSound/);
  input.segments[0].presentation = "spoken";
  const spoken = alignReferenceCreation(input, "复习", role, [extra]).segments[0];
  assert.equal(spoken.spokenText, "额外的口播");
  assert.equal(spoken.originalSound, "");
  assert.equal(spoken.screenText, "");
  assert.equal(spoken.table, null);
  assert.throws(() => alignReferenceCreation(input, "复习", role, [{ ...extra, spokenText: null }]), /spokenText/);
});

test("三个生成入口的每次模型调用均收到 B5 约束，未勾选的账号经历不入模", async t => {
  for (const mode of ["standard", "single", "reference"]) {
    const f = mode === "reference" ? await referenceFixture(t) : mode === "single" ? await singleBenchmarkFixture(t) : await contentGenerationFixture(t, []);
    f.seed("knowledge_items", { id: "author-profile", category: "brand_story", title: "未选账号资料", status: "confirmed" });
    f.seed("knowledge_item_versions", { item_id: "author-profile", version: 1, source_type: "manual", body: "经历原文_PRIVATE_B1",
      form_json: JSON.stringify({ kind: "profile", answers: { boundary: "不披露实习单位和真实人名", background: "秘密经历_PRIVATE_B3" } }) });
    const response = mode === "reference" ? await f.generate(f.input) : await f.complete();
    assert.equal(response.status, 200, await response.clone().text());
    for (const call of f.calls) {
      const prompt = JSON.stringify(call);
      assert.match(prompt, /不披露实习单位和真实人名/);
      assert.doesNotMatch(prompt, /PRIVATE_B[13]|未选账号资料|author-profile/);
      if (call.system) assert.match(call.system, /长期公开限制/);
    }
  }
});


test("生成期间撤销某段材料后，已有内容版本与引用均保持原样", async t => {
  const f = await referenceFixture(t, fixture => { fixture.sqlite.prepare("UPDATE knowledge_items SET status='draft' WHERE id='chosen'").run(); });
  const response = await f.generate(f.input);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id=?").get(f.contentId).current_version, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM content_citations WHERE content_item_id=?").get(f.contentId).n, 0);
});

test("本条明确禁止承诺下一集时，保留原来提出的问题并同步分镜，真实安排和开放提问可保留", () => {
  const correction = (note, spokenText, boundaries = []) => {
    const report = { segments: [{ ...emptyDelivery, segmentId: "last", note, spokenText }] };
    const fields = { storyboard: [{script: spokenText}], shortScript: spokenText };
    applyReferenceEndingRules(report, fields, boundaries);
    assert.equal(fields.storyboard[0].script, report.segments[0].spokenText);
    return report.segments[0].spokenText;
  };
  const forbid = "可用假设场景，不捏造个人经历或承诺下一集。";
  const promise = "下一条，我会继续演示：遇到复杂任务时，怎么把查资料、读文档和改代码串起来。";
  assert.equal(correction(forbid, promise), "遇到复杂任务时，怎么把查资料、读文档和改代码串起来？");
  assert.throws(() => correction(forbid, "下期我们会公布这次测试的结果。"), /删除具体更新预告/);
  assert.equal(correction(forbid, "三个场景里，你最想先核对哪一个？"), "三个场景里，你最想先核对哪一个？");
  assert.equal(correction(forbid, "下一期我们聊什么？"), "下一期我们聊什么？");
  assert.equal(correction("下一期已确认排在周三，这里可以预告。", promise), promise);
  assert.equal(correction("不要忘了预告下一期", promise), promise);
  assert.throws(() => correction("前文已提供安排", "下期分享录屏流程。", ["不承诺下一期"]), /删除具体更新预告/);
});
