import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t,kind) {
  const f=runtimeFixture(t),owner=await f.initialize(),project=crypto.randomUUID(),now="2026-10-14T00:00:00.000Z";f.identity.userId=owner.userId;
  function seed(table,values){const columns=f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name),data={id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:project,created_by:owner.userId,updated_by:owner.userId,created_at:now,updated_at:now,...values},entries=Object.entries(data).filter(([key])=>columns.includes(key));f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key)}) VALUES(${entries.map(()=>"?")})`).run(...entries.map(([,value])=>value));return data.id;}
  seed("projects",{id:project,name:"Synthetic",client_name:"Synthetic"});const topic=seed("topic_ideas",{title:"Synthetic",source_type:"manual"});
  const content=seed("content_items",{topic_id:topic,title:"Synthetic",status:kind==="submit"?"draft":"internal_review"}),version=seed("content_versions",{content_item_id:content,version:1,generation_mode:"manual",pack_json:"{}",full_script:"合成验收稿件。",short_script:"合成稿件。"});
  if(kind!=="submit")seed("content_reviews",{content_item_id:content,content_version_id:version,review_stage:"internal",round:1,decision:"pending",requested_by:owner.userId,requested_at:now});
  f.runtime.getProjectAccess=async()=>({userId:owner.userId,organizationId:owner.organizationId,organizationRole:"admin",projectId:project,projectRole:null});
  const input={organizationId:owner.organizationId,projectId:project,expectedVersion:1,toStatus:{submit:"internal_review",approve:"publish_ready",return:"internal_revision",archive:"archived"}[kind],...(kind==="return"?{note:"保留人工退回意见"}:{})};
  const call=(extra={})=>f.load("app/api/content-items/[contentId]/transition/route.ts").POST(new Request("http://localhost/transition",{method:"POST",headers:f.identity.cookie?{cookie:f.identity.cookie}:{},body:JSON.stringify({...input,...extra})}),{params:Promise.resolve({contentId:content})});
  const state=()=>Object.fromEntries(["content_items","content_reviews","project_memory_items","project_memory_evidence","audit_logs"].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const beforeWrite=action=>{const batch=f.db.batch;let done=false;f.db.batch=async statements=>{if(!done){done=true;action();}return batch(statements);};};
  return {...f,owner,project,content,seed,input,call,state,beforeWrite};
}

for(const kind of ["submit","approve","return","archive"]) {
  test(`${kind}: revoked membership prevents status, review, memory and audit writes`,async t=>{const f=await fixture(t,kind),before=f.state();f.beforeWrite(()=>f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run());assert.equal((await f.call()).status,403);assert.deepEqual(f.state(),before);});
  test(`${kind}: logout at transaction entry prevents all writes`,async t=>{const f=await fixture(t,kind),token="synthetic-review-token",hash=await f.runtime.sha256Hex(new TextEncoder().encode(token));f.seed("local_sessions",{user_id:f.owner.userId,token_hash:hash,expires_at:"2099-01-01T00:00:00Z",last_seen_at:"2026-10-14T00:00:00Z"});f.identity.cookie="liming_session="+token;const before=f.state();f.beforeWrite(()=>f.sqlite.prepare("DELETE FROM local_sessions").run());assert.equal((await f.call()).status,403);assert.deepEqual(f.state(),before);});
  test(`${kind}: audit failure preserves the entire snapshot`,async t=>{const f=await fixture(t,kind),before=f.state();f.sqlite.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='content.status.changed' BEGIN SELECT RAISE(ABORT,'synthetic review audit failure'); END");assert.equal((await f.call()).status,500);assert.deepEqual(f.state(),before);});
  test(`${kind}: lost acknowledgement reconciles without replay`,async t=>{const f=await fixture(t,kind),batch=f.db.batch;let attempts=0;f.db.batch=async statements=>{attempts++;await batch(statements);throw new Error("Synthetic receipt lost");};const response=await f.call();assert.equal(response.status,200);assert.equal(attempts,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='content.status.changed'").get().n,1);if(kind==="return"){const body=await response.json();assert.equal(f.sqlite.prepare("SELECT id FROM project_memory_items").get().id,body.memoryCandidate.id);}});
  test(`${kind}: old client missing the reviewed version must refresh`,async t=>{const f=await fixture(t,kind),before=f.state();assert.equal((await f.call({expectedVersion:undefined})).status,400);assert.deepEqual(f.state(),before);});
}

test("a changed pending review rejects approval without a phantom audit",async t=>{const f=await fixture(t,"approve");let expected;f.beforeWrite(()=>{f.sqlite.prepare("UPDATE content_reviews SET decision='cancelled'").run();expected=f.state();});assert.equal((await f.call()).status,409);assert.deepEqual(f.state(),expected);});
test("failure saving a returned suggestion rolls back the decision and state",async t=>{const f=await fixture(t,"return"),before=f.state();f.sqlite.exec("CREATE TRIGGER synthetic_memory_failure BEFORE INSERT ON project_memory_evidence BEGIN SELECT RAISE(ABORT,'synthetic suggestion evidence failure'); END");assert.equal((await f.call()).status,500);assert.deepEqual(f.state(),before);});
