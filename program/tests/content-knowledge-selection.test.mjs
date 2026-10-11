import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { contentGenerationFixture as fixture } from "./helpers/content-generation-fixture.mjs";
import * as production from "../lib/content-production.ts";

test("migration restores explicit choices from creation audit, never from inferred citations", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("CREATE TABLE topic_ideas (id TEXT, organization_id TEXT, project_id TEXT); CREATE TABLE audit_logs (id TEXT, organization_id TEXT, project_id TEXT, target_id TEXT, action TEXT, metadata_json TEXT, created_at TEXT)");
  for (const id of ["empty", "selected", "legacy", "unknown", "foreign"]) db.prepare("INSERT INTO topic_ideas VALUES (?, 'org', 'project')").run(id);
  const audit = (id, metadata, org = "org") => db.prepare("INSERT INTO audit_logs VALUES (?, ?, 'project', ?, 'topic.created', ?, '2026-09-12')").run(id, org, id, JSON.stringify(metadata));
  audit("empty", { sourceKnowledgeItemIds: [], sourceCount: 30 });
  audit("selected", { sourceKnowledgeItemIds: ["selected-case"] });
  audit("legacy", { sourceKnowledgeItemId: "legacy-case" });
  audit("foreign", { sourceKnowledgeItemIds: ["forbidden-case"] }, "other-org");
  db.exec(await readFile(new URL("../drizzle/0047_topic_explicit_knowledge_selection.sql", import.meta.url), "utf8"));
  const rows = Object.fromEntries(db.prepare("SELECT id, selected_knowledge_ids_json FROM topic_ideas").all().map(row => [row.id, JSON.parse(row.selected_knowledge_ids_json)]));
  assert.deepEqual(rows, { empty: [], selected: ["selected-case"], legacy: ["legacy-case"], unknown: [], foreign: [] });
});


for (const selection of [[], ["chosen"]]) test(`generation preserves strategy and exactly ${selection.length} explicitly selected knowledge sources`, async t => {
  const f = await fixture(t, selection), response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.length, 1);
  const prompt = production.parseModelJson(f.calls[0].user);
  assert.match(prompt.contextLayers.strategyGuidance, /内容策略继续指导创作方向与表达方式/);
  assert.match(prompt.contextLayers.strategyGuidance, /教育/);
  assert.doesNotMatch(prompt.contextLayers.projectFacts, /内容策略继续指导创作方向与表达方式/);
  assert.doesNotMatch(f.calls[0].user, /PLANNING_|PRIVATE_PERSONA/);
  assert.match(f.calls[0].user, /内容策略继续指导创作方向与表达方式/);
  assert.doesNotMatch(f.calls[0].user, /unselected品牌|foreign品牌/);
  if (!selection.length) assert.doesNotMatch(f.calls[0].user, /chosen品牌/);
  const version = f.sqlite.prepare("SELECT source_manifest_json, pack_json FROM content_versions WHERE content_item_id = ? AND version = 2").get(f.contentId);
  const sources = JSON.parse(version.source_manifest_json), pack = JSON.parse(version.pack_json);
  assert.deepEqual(sources.filter(s => s.sourceType === "knowledge").map(s => s.sourceId), selection);
  assert.deepEqual(pack.citations.filter(s => s.sourceType === "knowledge").map(s => s.sourceId), selection);
  assert.equal(sources.some(s => s.sourceType === "strategy"), true);
  assert.equal(f.queries.some(query => /FROM project_memory_items|FROM video_knowledge_atoms|FROM published_copy_records/.test(query)), false);
});

test("content task objective removes strategy fallback goals from model input", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE topic_ideas SET objective = ? WHERE id = ?").run("TASK_GOAL 让读者完成一次提问", f.topicId);
  const response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const prompt = production.parseModelJson(f.calls[0].user);
  assert.match(prompt.topic.objective, /TASK_GOAL/);
  assert.doesNotMatch(prompt.contextLayers.strategyGuidance, /教育/);
  assert.match(f.calls[0].system, /本次任务的明确目标优先/);
});

for (const borrow of [true, false]) test(`selected benchmark content may be ${borrow ? "borrowed" : "omitted"} through compatible generation retries`, async t => {
  const quote = "先约定验收条件再检查任务结果";
  const application = borrow
    ? "借鉴素材中先明确验收条件的内容，落在输出要求的例子；不迁移素材作者的经历。"
    : "本稿只参考分步讲解方法，素材内容与当前目标无关，未借鉴其案例。";
  const f = await fixture(t, [], (input, call, base) => {
    assert.match(input.system, /内容借鉴是可选的/);
    assert.match(input.system, /不要求每条都正向采用一种写法/);
    assert.doesNotMatch(input.system, /对标样本只用于学习方法|对标样本.*均不能支撑事实/);
    const prompt = production.parseModelJson(input.user);
    assert.match(prompt.contextLayers.referenceExamples, new RegExp(quote));
    assert.doesNotMatch(prompt.contextLayers.methodology, /只抽取钩子|方法库、对标、案例和历史成品只能指导结构/);
    assert.match(prompt.benchmarkUsageRequirements[0].requirement, /不强制采用/);
    if (call === 1) return {}; // Exercise the full-output retry, not only the initial prompt.
    assert.match(input.user, /未指定时不得补充品牌知识/);
    assert.doesNotMatch(input.user, /referenceExamples 只指导结构|至少一条项目 knowledge/);
    return { ...base, qualityReview: { ...base.qualityReview, benchmarkMethods: [{ sourceId: "benchmark", method: "分步讲解", application }] }, citations: [
      { sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" },
      { sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张" },
      { sourceType: "benchmark", sourceId: "benchmark", quote },
    ] };
  });
  f.seed("videos", { id: "benchmark-video", platform: "douyin", source_type: "url", title: "验收方法" });
  f.seed("video_library_entries", { id: "benchmark", source_video_id: "benchmark-video" });
  f.seed("video_analyses", { video_id: "benchmark-video", schema_version: "1", report_json: JSON.stringify({ summary: quote }) });
  f.seed("project_video_references", { library_entry_id: "benchmark", purpose: "benchmark", status: "active" });
  const response = await f.complete(["benchmark"]);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.calls.length, 2);
  const version = f.sqlite.prepare("SELECT pack_json, prompt_version FROM content_versions WHERE content_item_id = ? AND version = 2").get(f.contentId);
  assert.equal(version.prompt_version, production.CONTENT_PROMPT_VERSION);
  assert.deepEqual(JSON.parse(version.pack_json).qualityReview.benchmarkMethods, [{ sourceId: "benchmark", method: "分步讲解", application }]);
});

test("selected but inaccessible or revoked knowledge blocks generation instead of substituting other cases", async t => {
  const f = await fixture(t, ["foreign"]);
  assert.equal((await f.complete()).status, 409);
  assert.equal(f.calls.length, 0);
  f.sqlite.prepare("UPDATE topic_ideas SET selected_knowledge_ids_json = ? WHERE id = ?").run('["chosen"]', f.topicId);
  f.sqlite.exec("UPDATE knowledge_items SET status = 'archived' WHERE id = 'chosen'");
  assert.equal((await f.complete()).status, 409);
  assert.equal(f.calls.length, 0);
});

test("new content scaffolds do not inherit legacy unselected knowledge citations", async t => {
  const f = await fixture(t);
  // A fresh topic has not entered production yet.
  const topic = f.sqlite.prepare("SELECT * FROM topic_ideas WHERE id = ?").get(f.topicId);
  const fresh = { ...topic, id: "fresh-topic" };
  f.sqlite.prepare(`INSERT INTO topic_ideas (${Object.keys(fresh).join(",")}) VALUES (${Object.keys(fresh).map(() => "?").join(",")})`).run(...Object.values(fresh));
  f.sqlite.prepare("UPDATE topic_citations SET topic_id = ? WHERE topic_id = ?").run(fresh.id, f.topicId);
  const route = f.load("app/api/content-items/route.ts");
  const response = await route.POST(f.request({ topicId: fresh.id }));
  assert.equal(response.status, 201, await response.clone().text());
  const { item } = await response.json();
  const citations = f.sqlite.prepare("SELECT citation_type FROM content_citations WHERE content_item_id = ?").all(item.id);
  assert.deepEqual(citations.map(c => c.citation_type), ["topic"]);
});

for (const recover of [true, false]) test(`citation anchor failure ${recover ? "recovers without rewriting" : "stops after bounded repair and preserves the existing version"}`, async t => {
  const script = "第一部分，背景。你是谁，你现在什么情况。比如我是计算机专业大二学生。\n\n第二部分，目标。你到底要什么结果。";
  const f = await fixture(t, [], (input, call, base) => {
    if (call === 1) return { ...base, fullScript: script, citations: [{ sourceType: "strategy", sourceId: "strategy", quote: "内容策略继续指导创作方向与表达方式" }] };
    const prompt = JSON.parse(input.user);
    assert.equal(prompt.draft.fullScript, script);
    assert.doesNotMatch(prompt.error, /全部字段|完整口播稿|至少一条项目 knowledge/);
    if (call === 3) assert.match(prompt.error, /无法在稿件中连续定位/);
    const anchor = recover && call === 3
      ? { draftAnchorId: prompt.draftAnchors[0].id }
      : { draftQuote: "第一部分，背景。你是谁，你现在什么情况。第二部分，目标。你到底要什么结果。" };
    return { citations: [{ sourceType: "method_knowledge", sourceId: prompt.methodologyPlan.planId, quote: "一条内容只保留一个核心主张", ...anchor, application: "正文围绕如何交代任务这一核心主张逐项展开说明。" }] };
  });
  const response = await f.complete();
  assert.equal(response.status, recover ? 200 : 502, await response.clone().text());
  assert.equal(f.calls.length, 3);
  assert.equal(f.sqlite.prepare("SELECT current_version FROM content_items WHERE id = ?").get(f.contentId).current_version, recover ? 2 : 1);
  if (recover) {
    const version = f.sqlite.prepare("SELECT full_script FROM content_versions WHERE content_item_id = ? AND version = 2").get(f.contentId);
    assert.equal(version.full_script, script);
  } else {
    const diagnostic = JSON.parse(f.sqlite.prepare("SELECT output_json FROM model_calls WHERE topic_id = ?").get(f.topicId).output_json);
    assert.deepEqual(diagnostic.attempts.map(a => a.kind), ["generation", "citation_repair", "citation_repair"]);
    assert.equal(JSON.parse(diagnostic.attempts[0].content).fullScript, script);
    assert.match((await response.json()).error.message, /已有版本不受影响/);
  }
});
