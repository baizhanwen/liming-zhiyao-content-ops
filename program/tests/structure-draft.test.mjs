import assert from "node:assert/strict";
import test from "node:test";
import { structureFromAnalysis } from "../lib/structure-draft.ts";
import { contentAnalysisFixture, unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

const lines = ["资料太多，怎么挑？", "最后给你一张表，可以截图。", "先看任务，再看资料来源。", "最后给两条建议，动手核对，记下出处。", "下一条讲整理笔记。"];
const report = { spoken_script_set: { corrected_original: { status: "completed", text: lines.join("\n"), validation: { passed: true } } },
  content_analysis: { segments: [{ kind: "topic_problem", text: "资料太多时怎样挑选？" }] } };

test("a promised visual is a separate authored table and all spoken source text stays in sequence", () => {
  const skeleton = structureFromAnalysis(JSON.stringify(report), "视频原始标题");
  assert.equal(skeleton.referenceTopic, "资料太多时怎样挑选？");
  const segments = skeleton.segments;
  assert.equal(segments.filter(row => row.presentation === "spoken").map(row => row.excerpt).join(""), lines.join(""));
  const table = segments.find(row => row.presentation === "screen_table");
  assert.match(table.role, /新稿拟用画面/);
  assert.equal(table.startMs, null);
  const closing = segments.at(-1);
  assert.equal(closing.excerpt, "下一条讲整理笔记。");
  assert.equal(closing.role, "留下可继续探索的问题，有已确认的安排时再预告后续内容");
  assert.ok(segments.some(segment => segment.presentation === "spoken" && segment.excerpt.includes("最后给两条建议")));
  assert.throws(() => structureFromAnalysis(JSON.stringify({ summary: "分析摘要并非完整原稿" }), "标题"), error => error.code === "REFERENCE_MANUSCRIPT_REQUIRED");
});

async function fixture(t) {
  const f = await contentGenerationFixture(t);
  const org = f.sqlite.prepare("SELECT organization_id FROM projects WHERE id='project'").get().organization_id;
  const src = { project_id: "other" };
  f.seed("videos", { ...src, id: "video", platform: "douyin", source_type: "url", title: "资料怎么选" });
  f.seed("video_analyses", { ...src, id: "analysis", video_id: "video", schema_version: "1", report_json: JSON.stringify(report) });
  f.seed("video_library_entries", { id: "entry", source_video_id: "video" });
  f.seed("project_video_references", { id: "ref", library_entry_id: "entry", purpose: "benchmark", status: "active" });
  const scope = { organizationId: org, projectId: "project" };
  const route = f.load("app/api/videos/[videoId]/structure-draft/route.ts");
  const context = { params: Promise.resolve({ videoId: "video" }) };
  const get = (query = {}) => route.GET(new Request("http://localhost/api/videos/video/structure-draft?" + new URLSearchParams({ ...scope, ...query })), context);
  const write = body => route.POST(f.request(body), context);
  const data = await get({ analysisId: "analysis", libraryEntryId: "entry" }).then(r => r.json());
  assert.ok(data.segments?.length);
  const creation = { videoId: "video", analysisId: data.analysisId, topicMode: "custom", customTopic: "期末复习资料怎么选？",
    segments: data.segments.map(s => ({ segmentId: s.segmentId, materialIds: [], note: "", presentation: s.presentation })) };
  creation.segments[0].materialIds = ["chosen"];
  return { ...f, data, get, write, scope, creation };
}

test("shared analysis uses only the destination space strategy and materials, and pinned analysis must belong to the video", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.data.materials.map(m => m.id).sort(), ["chosen", "unselected"]);
  assert.equal(f.data.strategy.id, "strategy");
  assert.equal((await f.get({ analysisId: "missing" })).status, 404);
  assert.equal((await f.get({ libraryEntryId: "wrong" })).status, 404);
  assert.equal((await f.get({ projectId: "other" })).status, 403);
  f.sqlite.prepare("UPDATE project_video_references SET status='revoked' WHERE id='ref'").run();
  assert.equal((await f.get()).status, 404);
  assert.equal((await f.write({ requestId: "new", referenceCreation: f.creation })).status, 404);
});

test("atomic draft captures the selected references only; retries return the same content and different inputs conflict", async t => {
  const f = await fixture(t);
  const body = { requestId: "submission", referenceCreation: f.creation };
  const response = await f.write(body);
  assert.equal(response.status, 201, await response.clone().text());
  const item = await response.json();
  const retry = await f.write(body);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), item);
  assert.equal((await f.write({ ...body, referenceCreation: { ...f.creation, focus: "  " } })).status, 200);
  const fresh = await f.write({ ...body, referenceCreation: { ...f.creation, customTopic: "另一个选题" } });
  assert.equal(fresh.status, 409);
  const topic = f.sqlite.prepare("SELECT * FROM topic_ideas WHERE id=?").get(item.topicId);
  assert.equal(topic.source_ref, "video");
  assert.equal(topic.title, f.creation.customTopic);
  assert.deepEqual(JSON.parse(topic.selected_knowledge_ids_json), ["chosen"]);
  assert.deepEqual(f.sqlite.prepare("SELECT citation_id FROM topic_citations WHERE topic_id=? ORDER BY citation_id").all(item.topicId).map(c => c.citation_id), ["analysis","chosen"]);
  const pack = JSON.parse(f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=1").get(item.contentId).pack_json);
  assert.deepEqual(pack.referenceCreation, f.creation);
  const repeat = await f.write({ requestId: "same-topic", referenceCreation: { ...f.creation, topicMode: "reference" } }).then(r => r.json());
  assert.equal(f.sqlite.prepare("SELECT title FROM topic_ideas WHERE id=?").get(repeat.topicId).title, f.data.referenceTopic);
});

test("建稿保存规范化的写作重点，修改重点是新请求，审计只记录是否填写", async t => {
  const f = await fixture(t);
  const body = { requestId: "focus-submission", referenceCreation: { ...f.creation, focus: "  把注意力放在资料取舍上  " } };
  const first = await f.write(body);
  assert.equal(first.status, 201, await first.clone().text());
  const { contentId } = await first.json();
  const { pack_json } = f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=1").get(contentId);
  assert.deepEqual(JSON.parse(pack_json).referenceCreation, { ...f.creation, focus: body.referenceCreation.focus.trim() });
  const audit = JSON.parse(f.sqlite.prepare("SELECT metadata_json FROM audit_logs WHERE target_id=? AND action='content.structure_draft_created'").get(contentId).metadata_json);
  assert.equal(audit.hasFocus, true);
  assert.ok(!JSON.stringify(audit).includes("资料取舍"));
  assert.equal((await f.write({ ...body, referenceCreation: { ...f.creation, focus: "把注意力放在核对出处上" } })).status, 409);
  assert.equal((await f.write({ ...body, referenceCreation: { ...f.creation, focus: "重".repeat(301) } })).status, 400);
});

test("选灵感只快照该空间的标题，手填不创建灵感，旧请求重放仍指向原稿", async t => {
  const f = await fixture(t);
  const title = "椅子上的书怎么挑";
  const card = { title, canonical_key: "chair", core_insight: "这是灵感讨论中的设想，并非发生过的事实。", source_type: "manual", content_hash: "hash" };
  f.seed("project_inspiration_cards", { ...card, id: "idea" });
  f.seed("project_inspiration_cards", { ...card, id: "outside", project_id: "other" });
  const fromIdea = { ...f.creation, customTopic: title, idea: { kind: "card", id: "idea" } };
  const save = (referenceCreation, requestId = "with-idea") => f.write({ requestId, referenceCreation });
  assert.equal((await save({ ...fromIdea, topicMode: "reference" })).status, 400);
  assert.equal((await save({ ...fromIdea, idea: { kind: "card", id: "outside" } })).status, 409);
  assert.equal((await save({ ...fromIdea, customTopic: "已经换题了" })).status, 409);
  const saved = await save(fromIdea);
  assert.equal(saved.status, 201, await saved.clone().text());
  const { contentId } = await saved.json();
  const firstPack = f.sqlite.prepare("SELECT pack_json FROM content_versions WHERE content_item_id=? AND version=1").get(contentId).pack_json;
  assert.deepEqual(JSON.parse(firstPack).referenceCreation.idea, fromIdea.idea);
  assert.ok(!firstPack.includes(card.core_insight));
  f.sqlite.prepare("UPDATE project_inspiration_cards SET status='archived' WHERE id='idea'").run();
  assert.equal((await save(fromIdea, "another")).status, 409);
  assert.equal((await save(fromIdea)).status, 200);
  assert.equal((await save(f.creation, "typed")).status, 201);
  const oldTopicTitle = f.sqlite.prepare("SELECT title FROM topic_ideas WHERE id=?").get(f.topicId).title;
  assert.equal((await save({ ...f.creation, customTopic: oldTopicTitle, idea: { kind: "topic", id: f.topicId } }, "legacy-topic")).status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_inspiration_cards").get().n, 2);
});

test("rejects changed segment order and foreign or deactivated materials", async t => {
  const f = await fixture(t);
  const send = creation => f.write({ requestId: "invalid", referenceCreation: creation });
  assert.equal((await send({ ...f.creation, segments: [...f.creation.segments].reverse() })).status, 409);
  assert.equal((await send({ ...f.creation, segments: f.creation.segments.map((s,i) => i ? s : { ...s, materialIds: ["foreign"] }) })).status, 409);
  f.sqlite.prepare("UPDATE knowledge_items SET status='draft' WHERE id='chosen'").run();
  assert.equal((await send(f.creation)).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas WHERE source_type='video_analysis'").get().n, 0);
});


test("visual-only vlog uses verified timed frame observations, preserves source order and never asserts sound", () => {
  const c = contentAnalysisFixture();
  c.evidence_registry = [[0, "镜头里的学生推开图书馆的门"], [420, "笔记本上写下一道练习题"], [950, "手把做完的那页翻过去"]].map(([time, description], i) => ({
    id: `vision:000${i + 1}`, source: "vision", text: `人物动作：${description}；建议夸张地叙述成绩提升`, start_ms: time, end_ms: time, frame_group_id: null, asset_ref: null,
  }));
  const report = { content_analysis: c, recommendations: ["虚构开场和片尾对白"] };
  const build = () => structureFromAnalysis(JSON.stringify(report), "图书馆自习 Vlog");
  const result = build();
  assert.equal(result.referenceTopic, "图书馆自习 Vlog");
  assert.deepEqual(result.segments.map(s => [s.startMs, s.presentation]), [[0,"screen"],[420,"screen"],[950,"screen"]]);
  assert.ok(result.segments.every(s => s.role.includes("画面取样") && !s.excerpt.includes("建议")));
  c.module_status.visual.status = "failed";
  assert.throws(build, error => error.code === "REFERENCE_MANUSCRIPT_REQUIRED");
  c.module_status.visual.status = "completed";
  c.evidence_registry = c.evidence_registry.slice(0, 2);
  assert.throws(build, error => error.code === "REFERENCE_MANUSCRIPT_REQUIRED");
});

test("overlapping submissions share one topic, and a reference revoked at commit creates no draft", async t => {
  const f = await fixture(t);
  const body = { requestId: "race", referenceCreation: f.creation };
  const [a, b] = await Promise.all([f.write(body), f.write(body)]);
  assert.deepEqual([a.status,b.status].sort(), [200,201]);
  assert.equal((await a.json()).contentId, (await b.json()).contentId);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas WHERE source_type='video_analysis'").get().n, 1);
  const batch = f.db.batch;
  f.db.batch = async statements => {
    f.sqlite.prepare("UPDATE project_video_references SET status='revoked' WHERE id='ref'").run();
    return batch(statements);
  };
  const revoked = await f.write({ ...body, requestId: "revoked-at-commit" });
  assert.equal(revoked.status, 409, await revoked.clone().text());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_ideas WHERE source_type='video_analysis'").get().n, 1);
});

test("recorded table requires a timed visual observation; a recommendation alone stays a proposed visual", () => {
  const example = structuredClone(report);
  const analysis = example.content_analysis;
  analysis.module_status = { visual: { status: "completed", validation: { passed: true } } };
  analysis.evidence_registry = [{ source: "vision", text: "建议画面展示一张分工表", start_ms: 2500, end_ms: 2500 }];
  const table = () => structureFromAnalysis(JSON.stringify(example), "参考").segments.find(row => row.presentation === "screen_table");
  assert.equal(table().startMs, null);
  analysis.evidence_registry[0].text = "画面中出现一张分工表；建议今后加入更多图标";
  assert.equal(table().startMs, 2500);
  assert.equal(table().excerpt, "画面中出现一张分工表");
});


test("headed structure segments transfer functions to a new topic and preserve the original spoken excerpts and IDs", () => {
  const source = unifiedAnalysisReportFixture();
  const content = source.content_analysis;
  const canonical = source.unified_report.canonical;
  const text = ["哪种 AI 合适？", "试试先查资料，再核对出处。"];
  const rows = text.map((value,i) => ({...content.evidence_registry[0], id: `transcript:000${i + 1}`, text:value, start_ms:i * 500,end_ms:(i + 1) * 500}));
  content.evidence_registry = [...rows, ...content.evidence_registry.filter(row=>row.source !== "transcript")];
  canonical.segments = rows.map(row => ({source_segment_id:row.id,text:row.text,original_text:row.text,start_ms:row.start_ms,end_ms:row.end_ms,evidence_ids:[row.id]}));
  canonical.paragraphs = text;
  const tags = [["structure.role.hook"],["structure.role.method","structure.role.step","structure.role.summary","structure.role.cta"]];
  const hook = content.classifications.find(row => row.dimension_id === "hook.type");
  Object.assign(hook,{ state:"known",reason:null,tags:["hook.type.question"],primary_tag:"hook.type.question",evidence_ids:[rows[0].id] });
  content.segments = rows.map((row,i) => ({id:"part-"+i, kind:"structure", dimension_id:"structure.role",tags: tags[i],
    text:["用哪种 AI 合适来提问", "结尾给出选择 AI 的步骤和行动建议"][i], evidence_ids:[row.id],start_ms:row.start_ms,end_ms:row.end_ms}));
  const result=structureFromAnalysis(JSON.stringify(source),"AI 工具怎么选");
  assert.deepEqual(result.segments.map(row=>row.segmentId),["part-1","part-2"]);
  assert.deepEqual(result.segments.map(row=>row.role),["用提问开场","归纳方法，给出可执行的分步建议"]);
  assert.deepEqual(result.segments.map(row=>row.excerpt),text);
});

test("the studio picker lists only space-authorized analyses and uses the same structure evidence as generation", async t => {
  const f = await fixture(t);
  const route = f.load("app/api/studio/references/route.ts");
  const list = (query = {}) => route.GET(new Request("http://localhost/api/studio/references?" + new URLSearchParams({ ...f.scope, ...query })));
  f.seed("videos", { id: "incomplete", platform: "douyin", source_type: "url", title: "待核对的报告" });
  f.seed("video_analyses", { id: "incomplete-analysis", video_id: "incomplete", schema_version: "1", report_json: "{}" });
  const result = await (await list()).json();
  assert.equal(result.canWrite, true);
  assert.equal(result.videos.find(v => v.videoId === "video").segmentCount, f.data.segments.length);
  assert.match(result.videos.find(v => v.videoId === "incomplete").unavailableReason, /口播/);
  assert.equal((await (await list({ search: "待核对" })).json()).videos.length, 1);
  assert.equal((await list({ projectId: "other" })).status, 403);
  assert.equal((await list({ page: "0" })).status, 400);
  f.sqlite.prepare("UPDATE project_video_references SET purpose='analysis' WHERE id='ref'").run();
  assert.equal((await (await list()).json()).videos.some(v => v.videoId === "video"), false);
});
