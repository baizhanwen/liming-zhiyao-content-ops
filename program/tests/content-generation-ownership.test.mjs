import test from 'node:test';
import assert from 'node:assert/strict';
import {contentGenerationFixture} from './helpers/content-generation-fixture.mjs';

test('two requests for one unchanged content admit only one generation and provider call',async t=>{
  const f=await contentGenerationFixture(t),prepare=f.db.prepare;let held=false,enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO model_calls')){const run=statement.run;statement.run=async()=>{const result=await run();if(result.meta.changes&&!held){held=true;enter();await gate;}return result;};}return statement;};
  const first=f.complete();await entered;let second;
  try {second=await f.complete();}finally{release();}
  const original=await first;
  assert.equal(second.status,409);assert.equal((await second.json()).error.code,'CONTENT_GENERATION_IN_PROGRESS');
  assert.equal(original.status,200);assert.equal(f.calls.length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM model_calls').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT current_version FROM content_items WHERE id=?').get(f.contentId).current_version,2);
});

test('a content revision changed during reservation prevents spending a provider call',async t=>{
  const f=await contentGenerationFixture(t),prepare=f.db.prepare;let changed=false;
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO model_calls')){const run=statement.run;statement.run=async()=>{if(!changed){changed=true;f.sqlite.prepare('UPDATE content_items SET current_version=2 WHERE id=?').run(f.contentId);}return run();};}return statement;};
  const response=await f.complete();assert.equal(response.status,409);assert.equal(f.calls.length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM model_calls').get().n,0);
});

test('a root recovered immediately before version commit cannot save a late draft',async t=>{
  const f=await contentGenerationFixture(t),batch=f.db.batch;let recovered=false;
  f.db.batch=async statements=>{const root=f.sqlite.prepare("SELECT id FROM model_calls WHERE task_type='content_draft' AND status='started'").get();if(root&&!recovered){recovered=true;f.sqlite.prepare("UPDATE model_calls SET status='failed',error_code='WEB_PROCESS_INTERRUPTED',error_message='Keep recovery reason' WHERE id=?").run(root.id);}return batch(statements);};
  const response=await f.complete();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'MODEL_REQUEST_INTERRUPTED');
  assert.equal(f.sqlite.prepare('SELECT current_version FROM content_items WHERE id=?').get(f.contentId).current_version,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_versions WHERE content_item_id=?').get(f.contentId).n,1);
  const row=f.sqlite.prepare("SELECT * FROM model_calls WHERE task_type='content_draft'").get();assert.equal(row.status,'failed');assert.equal(row.error_code,'WEB_PROCESS_INTERRUPTED');assert.equal(row.error_message,'Keep recovery reason');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='content.generated'").get().n,0);
  assert.equal((await f.complete()).status,200,'A terminal recovered root must release this content for an intentional new attempt');
});

test('a follow-up request requires its own active generation root before consuming quota',async t=>{
  const f=await contentGenerationFixture(t),root=f.seed('model_calls',{topic_id:f.topicId,task_type:'content_draft',provider:'fixture',model_name:'fixture',model_profile:'max',prompt_version:'ownership',status:'failed',error_code:'WEB_PROCESS_INTERRUPTED',input_hash:'Synthetic',input_json:'{}'});
  const ledger=[],invoke=f.load('lib/recorded-content-model.ts').invokeRecordedContentRequest;
  const row=f.sqlite.prepare('SELECT organization_id,project_id FROM content_items WHERE id=?').get(f.contentId),id=crypto.randomUUID();
  let calls=0;
  await assert.rejects(invoke({system:'Synthetic',user:'Synthetic',profile:'max'},{id,rootCallId:root,...{organizationId:row.organization_id,projectId:row.project_id},topicId:f.topicId,promptTemplateId:null,promptVersion:'ownership',provider:'fixture',model:'fixture',userId:f.identity.userId,step:'generation',inputHash:'Synthetic',inputJson:'{}',monthlyLimit:1000,ledger,contentGeneration:{contentId:f.contentId,version:1,status:'draft'}},async()=>{calls++;return {content:'Synthetic',latencyMs:1};}),{code:'MODEL_REQUEST_INTERRUPTED'});
  assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM model_calls').get().n,1);assert.equal(ledger.length,0);
});

test('a finished generation releases the content for another intentional generation',async t=>{
  const f=await contentGenerationFixture(t);assert.equal((await f.complete()).status,200);assert.equal((await f.complete()).status,200);assert.equal(f.calls.length,2);assert.equal(f.sqlite.prepare('SELECT current_version FROM content_items WHERE id=?').get(f.contentId).current_version,3);
});

test('an active generation does not block a different topic in the same project',async t=>{
  const f=await contentGenerationFixture(t),topic=f.sqlite.prepare('SELECT * FROM topic_ideas WHERE id=?').get(f.topicId),otherTopic=f.seed('topic_ideas',{...topic,id:crypto.randomUUID()}),otherContent=f.seed('content_items',{topic_id:otherTopic,title:topic.title}),version=f.sqlite.prepare('SELECT * FROM content_versions WHERE content_item_id=?').get(f.contentId);
  f.seed('content_versions',{...version,id:crypto.randomUUID(),content_item_id:otherContent});
  const prepare=f.db.prepare;let held=false,enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('INSERT INTO model_calls')){const run=statement.run;statement.run=async()=>{const result=await run();if(result.meta.changes&&!held){held=true;enter();await gate;}return result;};}return statement;};
  const first=f.complete();await entered;let other;
  try {other=await f.load('app/api/content-items/[contentId]/generate/route.ts').POST(f.request({expectedVersion:1,benchmarkEntryIds:[],recommendedBenchmarkIds:[]}),{params:Promise.resolve({contentId:otherContent})});}finally{release();}
  assert.equal(other.status,200,await other.clone().text());assert.equal((await first).status,200);assert.equal(f.calls.length,2);
});
