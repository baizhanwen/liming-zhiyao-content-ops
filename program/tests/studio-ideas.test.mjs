import test from "node:test";
import assert from "node:assert/strict";
import { contentGenerationFixture } from "./helpers/content-generation-fixture.mjs";

test("the library unifies linked cards and topics, traces drafts, and guards the selected title in its own space", async t => {
  const f = await contentGenerationFixture(t);
  const { organization_id: organizationId, project_id: projectId } = f.sqlite.prepare("SELECT organization_id, project_id FROM topic_ideas WHERE id=?").get(f.topicId);
  const scope = { organizationId, projectId };
  const { listStudioIdeas, readStudioIdea, studioIdeaGuard } = f.load("lib/studio-ideas.ts");
  const card = f.seed("project_inspiration_cards", { canonical_key:"working-idea", title:"对话原话", core_insight:"从实际操作遇到的问题写起。", source_type:"manual", content_hash:"hash" });
  const topic = f.seed("topic_ideas", {title:"从故障开始讲",source_type:"inspiration_card",source_ref:card});
  f.seed("topic_ideas", {title:"其他空间",project_id:"other",source_type:"manual"});
  const oldDraft = f.seed("content_items", {title:"以前写的稿",topic_id:topic});
  const backing = f.seed("topic_ideas", {title:"创作时填写的题目",source_type:"video_analysis"});
  const newDraft = f.seed("content_items",{topic_id:backing,title:"参考创作的新稿"});
  f.seed("content_versions", {content_item_id:newDraft,version:1,generation_mode:"scaffold",pack_json:JSON.stringify({structureRequestDigest:"request",referenceCreation:{idea:{kind:"card",id:card}}}),full_script:"初稿",short_script:"初稿"});
  const {ideas} = await listStudioIdeas(f.db,scope,{detailed:true});
  assert.deepEqual(new Set(ideas.map(i=>i.id)), new Set([f.topicId,card]));
  const linked = ideas.find(i=>i.id===card);
  assert.equal(linked.originalTitle,"对话原话");
  assert.equal(linked.topicId,topic);
  assert.equal(linked.title,"从故障开始讲");
  assert.deepEqual(new Set(linked.drafts.map(d=>d.id)),new Set([oldDraft,newDraft]));
  assert.equal(await readStudioIdea(f.db,scope,"topic",backing),null);
  assert.equal(await readStudioIdea(f.db,{organizationId,projectId:"other"},"card",card),null);
  const allowed = title => {
    const {guard,bindings} = studioIdeaGuard(scope,"card",card,title);
    return Boolean(f.sqlite.prepare("SELECT 1 WHERE "+guard).get(...bindings));
  };
  assert.ok(allowed("从故障开始讲"));
  assert.equal(allowed("错误的标题"),false);
  f.sqlite.prepare("UPDATE project_inspiration_cards SET status='archived' WHERE id=?").run(card);
  assert.equal(allowed("从故障开始讲"),false);
  assert.equal(await readStudioIdea(f.db,scope,"card",card),null);
  assert.equal((await listStudioIdeas(f.db,scope,{history:true,focusId:topic})).ideas[0].id,card);
});

test("retrying a one-line library save reopens the same idea and validates its title", async t => {
  const f = await contentGenerationFixture(t);
  const scope = f.sqlite.prepare("SELECT organization_id AS organizationId, project_id AS projectId FROM topic_ideas WHERE id=?").get(f.topicId);
  const key = "a".repeat(32);
  const save = title => f.load("app/api/topics/route.ts").POST(new Request("http://localhost/api/topics", {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...scope,title,noteKey:key}),
  }));
  const first = await save("随手想法");
  assert.equal(first.status,201,await first.clone().text());
  const retry = await save("随手想法");
  assert.equal(retry.status,200);
  assert.equal((await first.json()).topic.id,(await retry.json()).topic.id);
  assert.equal((await save("另一条想法")).status,409);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM topic_ideas WHERE title='随手想法'").get().n,1);
});
