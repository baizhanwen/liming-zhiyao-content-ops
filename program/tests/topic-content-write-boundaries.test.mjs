import test from "node:test";
import assert from "node:assert/strict";
import {runtimeFixture} from "./helpers/runtime-fixture.mjs";

async function fixture(t,kind) {
  const f=runtimeFixture(t),owner=await f.initialize(),project=crypto.randomUUID(),now="2026-10-14T00:00:00.000Z";
  f.identity.userId=owner.userId;
  function seed(table,values) {
    const columns=f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
    const data={id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:project,created_by:owner.userId,updated_by:owner.userId,created_at:now,updated_at:now,...values};
    const entries=Object.entries(data).filter(([key])=>columns.includes(key));
    f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key)}) VALUES(${entries.map(()=>"?")})`).run(...entries.map(([,value])=>value));
    return data.id;
  }
  seed("projects",{id:project,name:"Synthetic",client_name:"Synthetic"});
  const knowledge=seed("knowledge_items",{title:"Synthetic source",category:"other",status:"confirmed"});
  const knowledgeVersion=seed("knowledge_item_versions",{item_id:knowledge,version:1,body:"Synthetic source body",source_type:"manual"});
  const topic=seed("topic_ideas",{title:"Synthetic topic",source_type:"manual",selected_knowledge_ids_json:JSON.stringify([knowledge])});
  const citation=seed("topic_citations",{topic_id:topic,citation_type:"knowledge",citation_id:knowledge,quote:"Synthetic source body"});
  f.runtime.getProjectAccess=async()=>({organizationRole:"admin",projectRole:null});
  f.runtime.canWriteProjectAccess=()=>true;
  const scope={organizationId:owner.organizationId,projectId:project};
  const input={topic:{...scope,title:"New synthetic topic",sourceKnowledgeItemIds:[knowledge]},content:{...scope,topicId:topic},delete:{...scope,topicId:topic,confirmationTitle:"Synthetic topic",expectedUpdatedAt:now}}[kind];
  const action={topic:"topic.created",content:"content.created",delete:"topic.deleted"}[kind];
  const call=(extra={})=>{
    const request=new Request("http://localhost/api/topics",{method:kind==="delete"?"DELETE":"POST",headers:f.identity.cookie?{cookie:f.identity.cookie}:{},body:JSON.stringify({...input,...extra})});
    return f.load(kind==="content"?"app/api/content-items/route.ts":"app/api/topics/route.ts")[kind==="delete"?"DELETE":"POST"](request);
  };
  const state=()=>Object.fromEntries(["topic_ideas","topic_citations","content_items","content_versions","content_citations","audit_logs"].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const beforeWrite=action=>{const batch=f.db.batch;let done=false;f.db.batch=async statements=>{if(!done){done=true;action();}return batch(statements);};};
  return {...f,owner,project,seed,topic,citation,knowledge,knowledgeVersion,now,input,action,call,state,beforeWrite};
}

for(const kind of ["topic","content","delete"]) {
  test(`${kind}: normal save preserves related rows and one audit`,async t=>{const f=await fixture(t,kind),response=await f.call();assert.equal(response.status,kind==="delete"?200:201,await response.clone().text());assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action=?").get(f.action).n,1);if(kind==="content"){assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_versions").get().n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_citations").get().n,2);}});
  test(`${kind}: revoked membership at transaction entry blocks all writes`,async t=>{const f=await fixture(t,kind),before=f.state();f.beforeWrite(()=>f.sqlite.exec("UPDATE organization_members SET status='inactive'"));assert.equal((await f.call()).status,403);assert.deepEqual(f.state(),before);});
  test(`${kind}: logout at transaction entry blocks all writes`,async t=>{const f=await fixture(t,kind),token="synthetic-topic-token",hash=await f.runtime.sha256Hex(new TextEncoder().encode(token));f.seed("local_sessions",{user_id:f.owner.userId,token_hash:hash,expires_at:"2099-01-01T00:00:00Z",last_seen_at:f.now});f.identity.cookie="liming_session="+token;const before=f.state();f.beforeWrite(()=>f.sqlite.exec("DELETE FROM local_sessions"));assert.equal((await f.call()).status,403);assert.deepEqual(f.state(),before);});
  test(`${kind}: audit failure rolls back all mutations`,async t=>{const f=await fixture(t,kind),before=f.state();f.sqlite.exec(`CREATE TRIGGER synthetic_topic_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='${f.action}' BEGIN SELECT RAISE(ABORT,'synthetic topic audit failure'); END`);assert.equal((await f.call()).status,500);assert.deepEqual(f.state(),before);});
  test(`${kind}: lost acknowledgement reconciles this save without replay`,async t=>{const f=await fixture(t,kind),batch=f.db.batch;let attempts=0;f.db.batch=async statements=>{attempts++;await batch(statements);throw new Error("Synthetic topic acknowledgement lost");};assert.equal((await f.call()).status,kind==="delete"?200:201);assert.equal(attempts,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action=?").get(f.action).n,1);});
  test(`${kind}: unreadable receipt is explicit uncertainty`,async t=>{const f=await fixture(t,kind),batch=f.db.batch,prepare=f.db.prepare;let committed=false;f.db.batch=async statements=>{await batch(statements);committed=true;throw new Error("Synthetic lost acknowledgement");};f.db.prepare=sql=>{const statement=prepare(sql);if(/^\s*SELECT id FROM audit_logs/.test(sql)){const first=statement.first;statement.first=async()=>{if(committed)throw new Error("Synthetic receipt read unavailable");return first();};}return statement;};const response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,"CONTENT_OPERATION_STATUS_UNKNOWN");assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action=?").get(f.action).n,1);});
}

for(const change of ["deleted","unconfirmed","version","body"])test(`topic: selected knowledge ${change} after preflight rejects stale citation`,async t=>{
  const f=await fixture(t,"topic"),before=f.state();f.beforeWrite(()=>{
    if(change==="deleted")f.sqlite.prepare("UPDATE knowledge_items SET deleted_at=? WHERE id=?").run(f.now,f.knowledge);
    if(change==="unconfirmed")f.sqlite.prepare("UPDATE knowledge_items SET status='draft' WHERE id=?").run(f.knowledge);
    if(change==="version"){f.seed("knowledge_item_versions",{item_id:f.knowledge,version:2,body:"Changed source",source_type:"manual"});f.sqlite.prepare("UPDATE knowledge_items SET current_version=2 WHERE id=?").run(f.knowledge);}
    if(change==="body")f.sqlite.prepare("UPDATE knowledge_item_versions SET body='Changed body' WHERE id=?").run(f.knowledgeVersion);
  });assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),before);
});

test("topic: deleted source video after preflight rejects the citation",async t=>{const f=await fixture(t,"topic"),video=f.seed("videos",{platform:"douyin",source_type:"url",status:"completed",source_url:"https://example.invalid/synthetic"});f.seed("video_analyses",{video_id:video,schema_version:"1",report_json:'{"summary":"Synthetic video conclusion"}',prompt_version:"synthetic",model_provider:"synthetic",model_name:"synthetic"});const before=f.state();f.beforeWrite(()=>f.sqlite.prepare("UPDATE videos SET deleted_at=? WHERE id=?").run(f.now,video));assert.equal((await f.call({sourceVideoId:video})).status,409);assert.deepEqual(f.state(),before);});

for(const change of ["deleted","archived","angle"])test(`content: topic ${change} at transaction entry cannot create stale scaffold`,async t=>{
  const f=await fixture(t,"content");let expected;f.beforeWrite(()=>{if(change==="deleted")f.sqlite.prepare("UPDATE topic_ideas SET deleted_at=? WHERE id=?").run(f.now,f.topic);if(change==="archived")f.sqlite.prepare("UPDATE topic_ideas SET status='archived' WHERE id=?").run(f.topic);if(change==="angle")f.sqlite.prepare("UPDATE topic_ideas SET angle='Changed after preflight' WHERE id=?").run(f.topic);expected=f.state();});assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),expected);
});

test("content: changed inherited citation does not become a stale content citation",async t=>{const f=await fixture(t,"content");let expected;f.beforeWrite(()=>{f.sqlite.prepare("UPDATE topic_citations SET quote='Changed citation' WHERE id=?").run(f.citation);expected=f.state();});assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),expected);});

test("content: concurrent creation returns a conflict and keeps the first complete scaffold",async t=>{const f=await fixture(t,"content"),batch=f.db.batch;let first;f.db.batch=async statements=>{f.db.batch=batch;first=await f.call();return batch(statements);};const second=await f.call();assert.equal(first.status,201);assert.equal(second.status,409);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_items").get().n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_versions").get().n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='content.created'").get().n,1);});

test("content: retained deleted content yields a useful conflict instead of a unique-index error",async t=>{const f=await fixture(t,"content"),id=f.seed("content_items",{topic_id:f.topic,title:"Retained history",deleted_at:f.now}),before=f.state();const response=await f.call();assert.equal(response.status,409);assert.deepEqual(f.state(),before);assert.ok(f.sqlite.prepare("SELECT id FROM content_items WHERE id=?").get(id));});

test("delete: administrator demotion still blocks deletion when project write permission remains",async t=>{const f=await fixture(t,"delete"),before=f.state();f.seed("project_members",{user_id:f.owner.userId,role:"manager",status:"active"});f.beforeWrite(()=>f.sqlite.prepare("UPDATE organization_members SET role='member' WHERE user_id=?").run(f.owner.userId));assert.equal((await f.call()).status,403);assert.deepEqual(f.state(),before);});
test("delete: stale page revision does not delete a newer topic",async t=>{const f=await fixture(t,"delete");f.sqlite.prepare("UPDATE topic_ideas SET updated_at='2026-10-14T00:00:00.001Z' WHERE id=?").run(f.topic);const before=f.state();assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),before);});
test("delete: title changed after exact-title confirmation rejects deletion",async t=>{const f=await fixture(t,"delete");let expected;f.beforeWrite(()=>{f.sqlite.prepare("UPDATE topic_ideas SET title='New topic title' WHERE id=?").run(f.topic);expected=f.state();});assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),expected);});
test("delete: old client missing revision must refresh",async t=>{const f=await fixture(t,"delete"),before=f.state();assert.equal((await f.call({expectedUpdatedAt:undefined})).status,400);assert.deepEqual(f.state(),before);});

test("topic: manual topic without sources remains supported",async t=>{const f=await fixture(t,"topic"),response=await f.call({sourceKnowledgeItemIds:[]});assert.equal(response.status,201);const body=await response.json();assert.deepEqual(body.sourcesUsed,[]);assert.deepEqual(body.missingContext,["EXPLICIT_FACT_REFERENCE"]);});
test("topic: twenty explicit knowledge sources save with all citations",async t=>{const f=await fixture(t,"topic"),ids=[f.knowledge];for(let i=1;i<20;i++){const id=f.seed("knowledge_items",{title:`Synthetic source ${i}`,category:"other",status:"confirmed"});f.seed("knowledge_item_versions",{item_id:id,version:1,body:`Synthetic body ${i}`,source_type:"manual"});ids.push(id);}const response=await f.call({sourceKnowledgeItemIds:ids});assert.equal(response.status,201,await response.clone().text());const body=await response.json();assert.equal(body.citations.length,20);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM topic_citations WHERE topic_id=?").get(body.topic.id).n,20);});
for(const [kind,table]of [["topic","topic_citations"],["content","content_versions"]])test(`${kind}: related-row failure rolls back the receipt and parent`,async t=>{const f=await fixture(t,kind),before=f.state();f.sqlite.exec(`CREATE TRIGGER synthetic_related_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic related-row failure'); END`);assert.equal((await f.call()).status,500);assert.deepEqual(f.state(),before);});
