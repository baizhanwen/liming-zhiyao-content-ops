import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import * as generation from "../lib/topic-generation.ts";
import { recommendTopicReferences } from "../lib/topic-reference-policy.ts";

async function fixture(t) {
  const f = runtimeFixture(t), installation = await f.initialize();
  f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, projectId = "topic-project", now = "2026-09-12T00:00:00.000Z";
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: projectId, name: "Test project", client_name: "Test account" });
  seed("projects", { id: "other-project", name: "Other", client_name: "Other" });
  seed("content_strategies", { version: 1, name: "Account direction", status: "active", positioning: "BACKGROUND_POSITION", target_audience: "BACKGROUND_AUDIENCE", style_notes: "BACKGROUND_STYLE", persona: "PRIVATE_PERSONAL_STORY", pain_points_json: '["PLANNING_PAIN"]', pillars_json: '["PLANNING_PILLAR"]', topic_mix_json: '{"PLANNING_MIX":50}', cadence: "PLANNING_CADENCE", conversion_path: "PLANNING_CONVERSION", objectives_json: '["education"]' });
  const knowledge = (id, body, overrides = {}) => {
    seed("knowledge_items", { id, category: "case_study", title: `AI 案例 ${id}`, status: "confirmed", ...overrides });
    seed("knowledge_item_versions", { item_id: id, version: 1, body, source_type: "manual", ...(overrides.project_id ? { project_id: overrides.project_id } : {}) });
  };
  knowledge("chosen", "SELECTED_CASE 倒计时和 Emoji 实测");
  knowledge("unselected", "UNSELECTED_CASE AI 历史经历");
  knowledge("foreign", "FOREIGN_CASE", { project_id: "other-project" });
  knowledge("draft", "DRAFT_CASE", { status: "draft" });
  knowledge("deleted", "DELETED_CASE", { deleted_at: now });
  seed("project_memory_items", { canonical_key: "case-copy", kind: "soft", category: "memory", status: "confirmed", title: "Case memory", content: "UNSELECTED_CASE memory duplicate", source_type: "manual", content_hash: "hash" });
  const calls = [], queries = [];
  const prepare = f.db.prepare;
  f.db.prepare = query => { queries.push(query); return prepare(query); };
  f.runtime.getProjectAccess = async (_identity, org, project) => org === organizationId && project === projectId ? { organizationRole: "member", projectRole: "member" } : null;
  f.runtime.canWriteProjectAccess = Boolean;
  f.mock("lib/generation-freeze.mjs.ts", { isGenerationFrozen: () => false });
  f.mock("lib/topic-generation.ts", generation);
  f.mock("lib/operations.ts", { checkOrganizationQuota: async () => ({ allowed: true, limit: 1000 }) });
  f.mock("lib/model-adapter.ts", {
    ModelConfigurationError: class extends Error {}, ModelRequestError: class extends Error {},
    readContentModelConfig: () => ({ provider: "fixture", model: "fixture" }),
    invokeContentModel: async input => { calls.push(input); return { content: '{"angle":"建议开展一次新的比较实验","hook":"准备比较不同任务的完成方式"}', latencyMs: 1 }; },
  });
  const generate = f.load("app/api/topics/generate/route.ts");
  const topics = f.load("app/api/topics/route.ts");
  const references = f.load("app/api/topics/references/route.ts");
  const request = payload => new Request("http://localhost/api/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, ...payload }) });
  return { ...f, organizationId, projectId, calls, queries, topics, references, request,
    complete: (overrides = {}) => generate.POST(request({ draft: { title: "AI 发展有多快" }, targets: ["angle"], sourceKnowledgeItemIds: [], ...overrides })) };
}

test("zero selections still reads core strategy, never hidden case copies or planning fields", async t => {
  const f = await fixture(t);
  const response = await f.complete();
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.sourcesUsed.map(source => source.sourceType).sort(), ["method_knowledge", "strategy", "topic"]);
  assert.match(f.calls[0].user, /BACKGROUND_POSITION/);
  assert.doesNotMatch(f.calls[0].user, /SELECTED_CASE|UNSELECTED_CASE|PLANNING_|PRIVATE_PERSONAL_STORY/);
  assert.equal(f.queries.some(query => /project_memory_items|video_knowledge_atoms|project_inspiration_cards/.test(query)), false);
  assert.equal(f.queries.some(query => /SELECT k.id.*knowledge_items/.test(query)), false);
  const audit = JSON.parse(f.sqlite.prepare("SELECT input_json FROM model_calls").get().input_json);
  assert.deepEqual(audit.sourceKnowledgeItemIds, []);
  assert.equal(audit.includeAccountBackground, true);
});

test("only selected knowledge reaches the prompt and displayed source snapshots match transmitted text", async t => {
  const f = await fixture(t);
  const response = await f.complete({ sourceKnowledgeItemIds: ["chosen"] });
  assert.equal(response.status, 200);
  const body = await response.json(), prompt = JSON.parse(f.calls[0].user.slice(f.calls[0].user.indexOf("\n") + 1));
  assert.match(f.calls[0].user, /SELECTED_CASE/);
  assert.doesNotMatch(f.calls[0].user, /UNSELECTED_CASE|FOREIGN_CASE|DRAFT_CASE|DELETED_CASE/);
  assert.deepEqual(body.sourcesUsed.filter(source => source.sourceType === "knowledge").map(source => source.sourceId), ["chosen"]);
  for (const source of body.sourcesUsed) {
    assert.equal(source.characterCount, source.text.length);
    assert.equal(source.contentHash, await f.runtime.sha256Hex(new TextEncoder().encode(source.text)));
    assert.ok(source.title);
    assert.ok(source.sourceType === "method_knowledge" ? prompt.methodology.includes(source.text) : source.sourceType === "strategy" ? JSON.stringify(prompt.accountBackground) === source.text : prompt.projectReferences.includes(source.text));
  }
});

test("core strategy is automatic even for old clients opting out; preview matches actual fields", async t => {
  const f = await fixture(t);
  const response = await f.complete({ includeAccountBackground: false });
  assert.equal(response.status, 200);
  assert.match(f.calls[0].user, /BACKGROUND_POSITION/);
  assert.doesNotMatch(f.calls[0].user, /PRIVATE_PERSONAL_STORY|UNSELECTED_CASE|SELECTED_CASE|PLANNING_/);
  const body = await response.json();
  assert.equal(body.sourcesUsed.filter(source => source.sourceType === "strategy").length, 1);
  const list = await f.topics.GET(new Request(`http://localhost/api/topics?organizationId=${f.organizationId}&projectId=${f.projectId}`));
  const preview = (await list.json()).accountBackground;
  assert.deepEqual(JSON.parse(body.sourcesUsed.find(source => source.sourceType === "strategy").text), preview);
});

test("explicit topic objective wins over strategy defaults and missing active strategy is visible", async t => {
  const f = await fixture(t);
  const response = await f.complete({ draft: { title: "AI 比较", objective: "TASK_GOAL" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const core = JSON.parse(body.sourcesUsed.find(s => s.sourceType === "strategy").text);
  assert.deepEqual(core.defaultObjectives, []);
  assert.match(f.calls[0].user, /TASK_GOAL/);
  assert.doesNotMatch(f.calls[0].user, /education/);
  f.sqlite.exec("UPDATE content_strategies SET status = 'retired'");
  const missing = await f.complete();
  assert.equal(missing.status, 409);
  assert.equal(f.calls.length, 1);
  const list = await f.topics.GET(new Request(`http://localhost/api/topics?organizationId=${f.organizationId}&projectId=${f.projectId}`));
  assert.equal((await list.json()).accountBackground, null);
});

test("invalid, unconfirmed, deleted and cross-project references block before model invocation", async t => {
  const f = await fixture(t);
  for (const id of ["missing", "foreign", "draft", "deleted"]) assert.equal((await f.complete({ sourceKnowledgeItemIds: [id] })).status, 409, id);
  assert.equal((await f.complete({ sourceVideoId: "unavailable-video" })).status, 409);
  assert.equal((await f.complete({ projectId: "other-project" })).status, 403);
  assert.equal((await f.complete({ includeAccountBackground: "true" })).status, 400);
  assert.equal(f.calls.length, 0);
});

test("recommendations have positive matches, enforce project scope and do not add citations or invoke a model", async t => {
  const f = await fixture(t);
  const response = await f.references.GET(new Request(`http://localhost/api/topics/references?organizationId=${f.organizationId}&projectId=${f.projectId}&query=AI`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.recommendations.map(item => item.id).sort(), ["chosen", "unselected"]);
  assert.ok(body.recommendations.every(item => item.matchedTerms.length && !Object.hasOwn(item, "body")));
  assert.equal(f.calls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM topic_citations").get().n, 0);
  assert.deepEqual(recommendTopicReferences("完全无关的烹饪", [{ id: "zero", title: "AI", category: "case_study", body: "Python" }]), []);
  assert.equal((await f.references.GET(new Request(`http://localhost/api/topics/references?organizationId=${f.organizationId}&projectId=other-project&query=AI`))).status, 403);
});

test("saving a topic preserves zero or explicit citations without silently expanding them", async t => {
  const f = await fixture(t);
  for (const ids of [[], ["chosen"]]) {
    const response = await f.topics.POST(f.request({ title: "AI 新选题", sourceKnowledgeItemIds: ids }));
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json();
    assert.deepEqual(body.citations.map(item => item.citation_id), ids);
    assert.deepEqual(body.sourcesUsed.map(item => item.sourceId), ids);
    const stored = f.sqlite.prepare("SELECT citation_id FROM topic_citations WHERE topic_id = ?").all(body.topic.id);
    assert.deepEqual(stored.map(item => item.citation_id), ids);
  }
});

test("existing fields remain explicit inputs and prompt distinguishes proposed experiments from personal history", async t => {
  const f = await fixture(t);
  assert.equal((await f.complete({ draft: { title: "AI 比较", hook: "USER_EDITED_HOOK" } })).status, 200);
  assert.match(f.calls[0].user, /USER_EDITED_HOOK/);
  assert.match(f.calls[0].system, /只能建议未来开展实验/);
});
