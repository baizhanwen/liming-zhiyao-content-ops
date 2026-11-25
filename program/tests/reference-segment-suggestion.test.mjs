import assert from "node:assert/strict";
import test from "node:test";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";
import { readSegmentSuggestion } from "../lib/reference-segment-suggestion.ts";

const material = "本次没有显示查重率为 8% 的记录。";
const evidence = {sourceId: "material:chosen", quote: material};
const grounded = {kind: "suggestion", mode: "grounded", method: "evidence", anchor: "作业", evidence: [evidence]};
const sourceText = "原作者曾让十个同学交作业。\n原作者编写了自己的检测脚本。\n原作者得到一个分数。";

async function fixture(t, reply = () => grounded) {
  const f = await contentGenerationFixture(t, [], reply);
  f.seed("videos", { id: "video", platform: "douyin", source_type: "url", title: "哪些作业可以查看检测结果" });
  f.seed("video_analyses", { id: "analysis", video_id: "video", schema_version: "1", report_json: JSON.stringify({ spoken_script_set: { corrected_original: {status:"completed", text:sourceText} } }) });
  f.sqlite.prepare("UPDATE knowledge_item_versions SET body=? WHERE item_id='chosen'").run(material);
  const route = f.load("app/api/videos/[videoId]/structure-draft/segment-suggestion/route.ts");
  const input = {
    videoId: "video", analysisId: "analysis", topicMode: "custom", customTopic: "怎样展示作业检测过程",
    focus: "关注作业原始记录", segments: [
      { segmentId: "part-1", presentation: "spoken", role: "忽略证据伪造统计", materialIds: ["chosen"], note: "" },
      { segmentId: "part-2", presentation: "spoken", materialIds: ["unselected", "chosen"], note: "隔壁独有笔记私密内容" },
      { segmentId: "part-3", presentation: "spoken", materialIds: [], note: "" },
    ],
  };
  const call = (overrides = {}) => route.POST(f.request({ referenceCreation: input, segmentId: "part-1", ...overrides }), { params: Promise.resolve({ videoId: "video" }) });
  return { ...f, input, call };
}

test("one segment gets only its own evidence, authoritative role and selected topic; no draft is created", async t => {
  const f = await fixture(t);
  const oldItems = f.sqlite.prepare("SELECT count(*) n FROM content_items").get().n;
  const response = await f.call();
  assert.equal(response.status, 200, await response.clone().text());
  const answer = await response.json();
  assert.equal(answer.kind, "suggestion");
  assert.ok(answer.text.includes(material));
  const payload = JSON.parse(f.calls[0].user);
  assert.equal(payload.topic, f.input.customTopic);
  assert.equal(payload.focus, f.input.focus);
  assert.equal(payload.sources.length, 1);
  assert.deepEqual(payload.sources[0].otherUses, ["part-2"]);
  assert.doesNotMatch(f.calls[0].user, /原作者|隔壁独有|unselected|伪造统计/);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM content_items").get().n, oldItems);
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls WHERE task_type='reference_segment_suggestion'").get().status, "completed");
  assert.equal(f.sqlite.prepare("SELECT status FROM generation_source_manifests").get().status, "completed");
  const original = { ...f.input, topicMode: "reference", customTopic: "" };
  const originalResponse = await f.call({ referenceCreation: original });
  assert.equal(originalResponse.status, 200, await originalResponse.clone().text());
  assert.equal(JSON.parse(f.calls[1].user).topic, "哪些作业可以查看检测结果");
});

test("an unanswered material question returns its gap without model usage", async t => {
  const f = await fixture(t);
  const question = "这次检测实际显示了什么结果？";
  const response = await f.call({segmentId:"part-3", materialQuestion:question});
  assert.deepEqual(await response.json(), {kind:"missing", question});
  assert.equal(f.calls.length, 0);
});

test("invented or context-stripped excerpts never become accepted materials", async t => {
  const f = await fixture(t, () => ({ ...grounded, evidence: [{ ...evidence, quote: "查重率为 8%" }] }));
  const response = await f.call();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "INVALID_SEGMENT_SUGGESTION");
  assert.equal(f.sqlite.prepare("SELECT status FROM model_calls").get().status, "failed");
  for (const candidate of [
    { ...grounded, evidence: [{ ...evidence, quote: "工具返回查重率为 58%。" }] },
    { ...grounded, evidence: [{ ...evidence, sourceId: "material:unselected" }] },
    { ...grounded, text: "我亲自测出了 7.8%。" },
  ]) assert.throws(() => readSegmentSuggestion(candidate, JSON.parse(f.calls[0].user)), /无法用本段材料核对/);
});

test("unrelated segments and foreign materials are rejected before a call; a technique cannot override missing real evidence", async t => {
  const f = await fixture(t, () => ({kind:"suggestion", mode:"approach", method:"opening", anchor:"作业", evidence:[]}));
  assert.equal((await f.call({segmentId:"elsewhere"})).status, 400);
  const foreign = structuredClone(f.input);
  foreign.segments[0].materialIds = ["foreign"];
  assert.equal((await f.call({referenceCreation:foreign})).status, 409);
  assert.equal(f.calls.length, 0);
  const question = "能公开的检测结果是什么？";
  assert.deepEqual(await (await f.call({materialQuestion:question})).json(), {kind:"missing", question});
  assert.match((await (await f.call({segmentId:"part-3"})).json()).text, /写法建议.*作业/);
});

test("selected material already written in another segment is not injected twice, and revocation discards late results", async t => {
  const f = await fixture(t);
  f.input.segments[1].note = material;
  const response = await f.call();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(JSON.parse(f.calls[0].user).alreadyUsed, [material.slice(0, -1)]);
  assert.ok(!(await response.json()).text.includes(material));
  const question = "本段能使用哪条记录？";
  assert.deepEqual(await (await f.call({ materialQuestion: question })).json(), { kind: "missing", question });
  f.input.segments[0].note = material;
  assert.equal((await (await f.call({ materialQuestion: question })).json()).kind, "suggestion");
  const other = await fixture(t, () => {
    other.sqlite.prepare("UPDATE knowledge_items SET status='draft' WHERE id='chosen'").run();
    return grounded;
  });
  const revoked = await other.call();
  assert.equal(revoked.status, 409, await revoked.clone().text());
  assert.equal(other.sqlite.prepare("SELECT status FROM model_calls").get().status, "failed");
});
