import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";
import { CONTENT_SYSTEM_PROMPT, createProductionScaffold, generateContentSchema, parseModelJson } from "../lib/content-production.ts";
import { incompleteScriptReason } from "../lib/content-writing-intent.ts";
import { applyCitationRepair, buildCitationDraftAnchors, buildCitationSourceAnchors } from "../lib/content-citation-recovery.ts";

const scienceScript = "AI的发展，可以看作解决问题的方法不断变化。早期，人们尝试把知识写成明确规则，让计算机一步步推理。但现实中的情况太多，规则很难全部写完。机器学习转而让计算机从数据中寻找规律，深度学习进一步使用多层神经网络处理复杂信息。今天的大模型先通过大量数据学习，再适应不同任务。它们不是突然出现的，而是算法、数据和计算能力长期积累的结果。";
const scienceShort = "AI从人工编写规则，走向从数据中学习，再发展出能适应多种任务的大模型。每一步都在解决前一种方法的局限。";
const scienceIntent = { kind: "explain", reason: "选题需要通俗解释人工智能的发展脉络" };

function scienceOutput(input, base) {
  const prompt = parseModelJson(input.user);
  return { ...base, fullScript: scienceScript, shortScript: scienceShort, writingIntent: scienceIntent, citations: [
    { sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" },
    { sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张" },
  ] };
}

test("no-source AI history uses automatic intent, saves a real script and never reads unselected company facts", async t => {
  const f = await contentGenerationFixture(t, [], (input, _call, base) => {
    const prompt = parseModelJson(input.user);
    assert.equal(prompt.taskBrief.writingIntent, "auto");
    assert.equal(prompt.taskBrief.companyKnowledgeSelected, false);
    assert.deepEqual(prompt.materialSelection.selectedIds, []);
    assert.equal(prompt.contextLayers.projectFacts, "");
    assert.match(input.system, /没有用户素材仍须完成可直接念出的口播稿/);
    return scienceOutput(input, base);
  });
  f.sqlite.prepare("UPDATE topic_ideas SET title = ? WHERE id = ?").run("AI发展史", f.topicId);
  const response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const { item } = await response.json();
  assert.equal(item.full_script, scienceScript);
  assert.equal(item.current_version, 2);
  const pack = JSON.parse(item.pack_json);
  assert.deepEqual(pack.writingIntent, scienceIntent);
  assert.ok(pack.citations.every(c => c.sourceType !== "knowledge"));
  assert.equal(f.calls.length, 1);
});

test("explicit intent overrides automatic inference and mismatches trigger a rewrite", async t => {
  const f = await contentGenerationFixture(t, [], (input, call, base) => {
    const prompt = parseModelJson(input.user);
    assert.equal(prompt.taskBrief.writingIntent, "opinion");
    if (call === 2) assert.match(input.user, /实际创作意图与用户选择不一致/);
    return { ...scienceOutput(input, base), writingIntent: call === 1 ? scienceIntent : { kind: "opinion", reason: "用户明确选择观点表达" } };
  });
  const response = await f.complete([], { writingIntent: "opinion" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse((await response.json()).item.pack_json).writingIntent.kind, "opinion");
});

test("selected company facts can remain unused when unrelated to the explanation", async t => {
  const f = await contentGenerationFixture(t, ["chosen"], (input, _call, base) => scienceOutput(input, base));
  const response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const pack = JSON.parse((await response.json()).item.pack_json);
  const selected = pack.sourceUsageReport.groups.find(group => group.key === "selected_knowledge");
  assert.equal(selected.availableCount, 1);
  assert.equal(selected.citedCount, 0);
  assert.equal(selected.required, false);
  assert.equal(pack.sourceUsageReport.status, "verified");
});

test("placeholder output fails clearly, persists its failure and cannot become a new version", async t => {
  const f = await contentGenerationFixture(t, [], (input, _call, base) => ({ ...scienceOutput(input, base), fullScript: "先把常见误区讲清楚，再结合已确认的品牌事实补充方法、案例或证据。" }));
  const response = await f.complete();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "INCOMPLETE_CONTENT_SCRIPT");
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id = ?").get(f.contentId).current_version, 1);
  const orgId = f.sqlite.prepare("SELECT organization_id FROM content_items WHERE id = ?").get(f.contentId).organization_id;
  const get = await f.load("app/api/content-items/route.ts").GET(new Request(`http://localhost/api/content-items?organizationId=${orgId}&projectId=project`));
  assert.equal(get.status, 200);
  const item = (await get.json()).items.find(item => item.id === f.contentId);
  assert.equal(item.latest_generation_status, "failed");
  assert.match(item.latest_generation_error, /占位文字/);
});

test("unwritten scaffolds cannot enter review, while a manually written script can be saved", async t => {
  const f = await contentGenerationFixture(t);
  f.runtime.getProjectAccess = async () => ({ organizationRole: "member", projectRole: "editor" });
  const params = { params: Promise.resolve({ contentId: f.contentId }) };
  const transition = f.load("app/api/content-items/[contentId]/transition/route.ts");
  const rejected = await transition.POST(f.request({ expectedVersion:1,toStatus: "internal_review" }), params);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "CONTENT_SCRIPT_REQUIRED");
  const pack = createProductionScaffold({ id: f.topicId, title: "AI" });
  f.sqlite.prepare("UPDATE topic_ideas SET title = ? WHERE id = ?").run("AI", f.topicId);
  const save = f.load("app/api/content-items/[contentId]/route.ts");
  const saved = await save.PATCH(f.request({ pack: { ...pack, fullScript: scienceScript, shortScript: scienceShort } }), params);
  assert.equal(saved.status, 200, await saved.clone().text());
  const reviewed = await transition.POST(f.request({ expectedVersion:2,toStatus: "internal_review" }), params);
  assert.equal(reviewed.status, 200, await reviewed.clone().text());
});

test("repair selects actual source excerpts and rejects invented source selections", () => {
  const draft = { ...createProductionScaffold({ id: "topic", title: "AI发展史" }), fullScript: scienceScript, shortScript: scienceShort };
  const sources = [{ sourceType: "topic", sourceId: "topic", text: draft.citations[0].quote }, { sourceType: "method_knowledge", sourceId: "long-real-plan-id", text: "用一条主线解释关键转折，并逐项兑现开头的承诺。" }];
  const source = buildCitationSourceAnchors(sources).find(anchor => anchor.sourceType === "method_knowledge");
  const patch = { citations: [{ sourceAnchorId: source.id, draftAnchorId: buildCitationDraftAnchors(draft)[0].id, application: "按AI解决问题的方法变化这一主线解释不同阶段，兑现开头的解释承诺。" }] };
  const repaired = applyCitationRepair(draft, patch, sources, []);
  assert.deepEqual(repaired.pack.citations.at(-1), { sourceType: source.sourceType, sourceId: source.sourceId, quote: source.quote });
  assert.equal(repaired.pack.fullScript, scienceScript);
  assert.throws(() => applyCitationRepair(draft, { citations: [{ ...patch.citations[0], sourceAnchorId: "source:foreign:0" }] }, sources, []), /不存在的来源片段/);
});

test("intent input remains optional for old clients and unsupported intents are rejected", () => {
  assert.equal(generateContentSchema.parse({ organizationId: "org", projectId: "project" }).writingIntent, "auto");
  assert.equal(generateContentSchema.safeParse({ organizationId: "org", projectId: "project", writingIntent: "invent-results" }).success, false);
  assert.match(CONTENT_SYSTEM_PROMPT, /不能仅因账号属于企业就判断为品牌介绍/);
  assert.ok(incompleteScriptReason(createProductionScaffold({ id: "topic", title: "AI" })));
});
