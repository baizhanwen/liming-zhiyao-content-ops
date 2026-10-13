import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f=runtimeFixture(t),owner=await f.initialize(),project=crypto.randomUUID(),now="2026-10-13T00:00:00.000Z";
  f.identity.userId=owner.userId;
  function seed(table,values) {
    const columns=f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
    const data={id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:project,created_by:owner.userId,updated_by:owner.userId,created_at:now,updated_at:now,...values};
    const entries=Object.entries(data).filter(([key])=>columns.includes(key));
    f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key)}) VALUES(${entries.map(()=>"?")})`).run(...entries.map(([,value])=>value));return data.id;
  }
  seed("projects",{id:project,name:"Synthetic",client_name:"Synthetic"});
  const topic=seed("topic_ideas",{title:"Synthetic",source_type:"manual"}),content=seed("content_items",{topic_id:topic,title:"Synthetic",status:"publish_ready"});
  const version=seed("content_versions",{content_item_id:content,version:1,generation_mode:"manual",pack_json:"{}",full_script:"合成稿件，仅用于隔离软件验收。",short_script:"合成稿件。"});
  seed("content_reviews",{content_item_id:content,content_version_id:version,review_stage:"internal",round:1,decision:"approved",requested_by:owner.userId,requested_at:now,decided_by:owner.userId,decided_at:now});
  const comment=seed("content_comments",{content_item_id:content,content_version_id:version,author_user_id:owner.userId,visibility:"internal",body:"Synthetic comment"});
  f.runtime.getProjectAccess=async()=>({userId:owner.userId,organizationId:owner.organizationId,organizationRole:"admin",projectId:project,projectRole:null});
  const scope={organizationId:owner.organizationId,projectId:project};
  const request=body=>new Request("http://localhost/workflow",{method:"POST",headers:f.identity.cookie?{cookie:f.identity.cookie}:{},body:JSON.stringify({...scope,...body})});
  function call(kind,extra={},legacy=true) {
    const definitions={
      publication:{schema:"publicationRecordSchema",route:"app/api/content-items/[contentId]/publications/route.ts",method:"POST",body:{expectedVersion:1,platform:"douyin",status:"published",externalUrl:"https://example.invalid/published"}},
      schedule:{schema:"scheduleContentSchema",route:"app/api/content-items/[contentId]/schedule/route.ts",method:"PUT",body:{expectedVersion:1,expectedUpdatedAt:f.sqlite.prepare("SELECT updated_at FROM content_schedules WHERE content_item_id=? AND status!='cancelled' ORDER BY updated_at DESC LIMIT 1").get(content)?.updated_at??null,platform:"douyin",status:"planned",scheduledAt:"2026-10-15T00:00:00Z"}},
      comment:{schema:"createContentCommentSchema",route:"app/api/content-items/[contentId]/comments/route.ts",method:"POST",body:{expectedVersion:1,visibility:"internal",body:"Synthetic new comment"}},
      resolve:{schema:"resolveContentCommentSchema",route:"app/api/content-comments/[commentId]/route.ts",method:"PATCH",body:{resolved:true,expectedUpdatedAt:f.sqlite.prepare("SELECT updated_at FROM content_comments WHERE id=?").get(comment).updated_at}},
    };
    const d=definitions[kind],body={...d.body,...extra};
    // Replay each old UI protocol on the archived baseline, preserving the same
    // logical operation; new routes require the version the caller has read.
    if(legacy){const schema=f.load("lib/content-workflow.ts")[d.schema];for(const key of ["expectedVersion","expectedUpdatedAt"])if(!schema.shape[key])delete body[key];}
    return f.load(d.route)[d.method](request(body),{params:Promise.resolve({contentId:content,commentId:comment})});
  }
  function beforeWrite(action) {
    const batch=f.db.batch,prepare=f.db.prepare;let changed=false;
    const once=()=>{if(!changed){changed=true;action();}};
    f.db.batch=async statements=>{once();return batch(statements);};
    f.db.prepare=sql=>{const s=prepare(sql);if(sql.startsWith("UPDATE content_comments")){const run=s.run;s.run=async()=>{once();return run();};}return s;};
  }
  const state=()=>Object.fromEntries(["content_items","content_comments","content_schedules","publication_records","published_copy_records","audit_logs"].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  function advance() {
    const next=seed("content_versions",{content_item_id:content,version:2,generation_mode:"manual",pack_json:"{}",full_script:"合成的新版本稿件。",short_script:"合成新版。"});
    f.sqlite.prepare("UPDATE content_items SET current_version=2,updated_at='2026-10-14T00:00:00Z' WHERE id=?").run(content);
    seed("content_reviews",{content_item_id:content,content_version_id:next,review_stage:"internal",round:2,decision:"approved",requested_by:owner.userId,requested_at:now,decided_by:owner.userId,decided_at:now});return next;
  }
  return {...f,owner,project,content,version,comment,scope,seed,call,request,beforeWrite,state,advance};
}

for(const kind of ["publication","schedule","comment","resolve"]) {
  test(`${kind}: removed authority at transaction entry writes no business data or audit`,async t=>{
    const f=await fixture(t),before=f.state();f.beforeWrite(()=>f.sqlite.prepare("UPDATE organization_members SET status='inactive' WHERE user_id=?").run(f.owner.userId));
    assert.equal((await f.call(kind)).status,403);assert.deepEqual(f.state(),before);
  });
  test(`${kind}: archiving content at transaction entry prevents stale writes`,async t=>{
    const f=await fixture(t);let expected;f.beforeWrite(()=>{f.sqlite.prepare("UPDATE content_items SET status='archived' WHERE id=?").run(f.content);expected=f.state();});
    assert.equal((await f.call(kind)).status,409);assert.deepEqual(f.state(),expected);
  });
  test(`${kind}: audit failure rolls back all side effects`,async t=>{
    const f=await fixture(t),before=f.state(),action={publication:"content.publication.saved",schedule:"content.schedule.saved",comment:"content.comment.created",resolve:"content.comment.resolved"}[kind];
    f.sqlite.exec(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'synthetic workflow audit failure'); END`);
    assert.equal((await f.call(kind)).status,500);assert.deepEqual(f.state(),before);
  });
  test(`${kind}: lost acknowledgement reconciles once instead of replaying`,async t=>{
    const f=await fixture(t),batch=f.db.batch;let attempts=0;f.db.batch=async statements=>{attempts++;await batch(statements);throw new Error("Synthetic lost acknowledgement");};
    assert.equal((await f.call(kind)).status,kind==="comment"?201:200);assert.equal(attempts,1);
  });
}

for(const kind of ["publication","schedule","comment"])test(`${kind}: content revision during save is rejected`,async t=>{
  const f=await fixture(t);let expected;f.beforeWrite(()=>{f.advance();expected=f.state();});
  assert.equal((await f.call(kind)).status,409);assert.deepEqual(f.state(),expected);
});

for(const kind of ["schedule","comment"])test(`${kind}: stale page cannot bind itself to a newer version`,async t=>{
  const f=await fixture(t);f.advance();assert.equal((await f.call(kind,{expectedVersion:1})).status,409);
});

test("publication update rejects a concurrent winner rather than overwriting its URL",async t=>{
  const f=await fixture(t),saved=await (await f.call("publication")).json();
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE publication_records SET external_url='https://example.invalid/winner',updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(saved.publication.id));
  assert.equal((await f.call("publication",{publicationId:saved.publication.id,expectedUpdatedAt:saved.publication.updated_at})).status,409);
  assert.equal(f.sqlite.prepare("SELECT external_url FROM publication_records WHERE id=?").get(saved.publication.id).external_url,"https://example.invalid/winner");
});

test("schedule update rejects a concurrent winner",async t=>{
  const f=await fixture(t),saved=await (await f.call("schedule")).json();
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE content_schedules SET notes='Concurrent winner',updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(saved.schedule.id));
  assert.equal((await f.call("schedule",{expectedUpdatedAt:saved.schedule.updated_at})).status,409);
  assert.equal(f.sqlite.prepare("SELECT notes FROM content_schedules WHERE id=?").get(saved.schedule.id).notes,"Concurrent winner");
});

test("duplicate schedule creation preserves the first active plan",async t=>{
  const f=await fixture(t);f.beforeWrite(()=>f.seed("content_schedules",{content_item_id:f.content,content_version_id:f.version,platform:"douyin",scheduled_at:"2026-10-15T00:00:00Z",timezone:"Asia/Shanghai",status:"planned"}));
  assert.equal((await f.call("schedule",{expectedUpdatedAt:null})).status,409);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_schedules").get().n,1);
});

for(const other of ["platform","version"])test(`publication does not complete a schedule for another ${other}`,async t=>{
  const f=await fixture(t),saved=await (await f.call("schedule",{platform:other==="platform"?"xiaohongshu":"douyin"})).json();
  if(other==="version")f.advance();
  const response=await f.call("publication",{expectedVersion:other==="version"?2:1});assert.equal(response.status,200);
  assert.equal((await response.json()).publication.schedule_id,null);assert.equal(f.sqlite.prepare("SELECT status FROM content_schedules WHERE id=?").get(saved.schedule.id).status,"planned");
});


for(const kind of ["publication","schedule","comment","resolve"])test(`${kind}: logout at commit rejects the old local session`,async t=>{
  const f=await fixture(t),token="synthetic-workflow-token",hash=await f.runtime.sha256Hex(new TextEncoder().encode(token));
  f.seed("local_sessions",{user_id:f.owner.userId,token_hash:hash,expires_at:"2099-01-01T00:00:00Z",last_seen_at:"2026-10-13T00:00:00Z"});f.identity.cookie="liming_session="+token;
  const before=f.state();f.beforeWrite(()=>f.sqlite.prepare("DELETE FROM local_sessions").run());
  assert.equal((await f.call(kind)).status,403);assert.deepEqual(f.state(),before);
});

for(const kind of ["publication","schedule","comment","resolve"])test(`${kind}: old client must refresh before saving without a read version`,async t=>{
  const f=await fixture(t),before=f.state(),response=await f.call(kind,{expectedVersion:undefined,expectedUpdatedAt:undefined},false);
  assert.equal(response.status,400);assert.deepEqual(f.state(),before);
});

for(const committed of [false,true])test(`workflow unknown receipt remains explicit after ${committed?"committed":"failed"} transaction`,async t=>{
  const f=await fixture(t),batch=f.db.batch,prepare=f.db.prepare;let attempts=0;
  f.db.batch=async statements=>{attempts++;if(committed)await batch(statements);throw new Error("Synthetic batch acknowledgement lost");};
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith("SELECT id FROM audit_logs"))statement.first=async()=>{throw new Error("Synthetic receipt unavailable");};return statement;};
  const response=await f.call("comment");assert.equal(response.status,503);assert.equal((await response.json()).error.code,"CONTENT_OPERATION_STATUS_UNKNOWN");assert.equal(attempts,1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM content_comments").get().n,committed?2:1);
});

test("comment resolution does not overwrite a concurrent edit",async t=>{
  const f=await fixture(t),stamp=f.sqlite.prepare("SELECT updated_at FROM content_comments WHERE id=?").get(f.comment).updated_at;
  f.beforeWrite(()=>f.sqlite.prepare("UPDATE content_comments SET body='Concurrent moderator edit',updated_at='2099-01-01T00:00:00Z' WHERE id=?").run(f.comment));
  assert.equal((await f.call("resolve",{expectedUpdatedAt:stamp})).status,409);const row=f.sqlite.prepare("SELECT body,resolved_at FROM content_comments WHERE id=?").get(f.comment);assert.equal(row.body,"Concurrent moderator edit");assert.equal(row.resolved_at,null);
});
