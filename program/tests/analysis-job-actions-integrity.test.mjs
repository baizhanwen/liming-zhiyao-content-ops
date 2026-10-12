import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t,action='retry'){
  const f=runtimeFixture(t),owner=await f.initialize();f.identity.userId=owner.userId;const now=new Date().toISOString(),project=crypto.randomUUID(),video=crypto.randomUUID(),job=crypto.randomUUID();
  f.sqlite.prepare('INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(project,owner.organizationId,'Synthetic','Synthetic',owner.userId,owner.userId,now,now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,source_hash,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,'synthetic-action','ready',?,?,?,?)").run(video,owner.organizationId,project,'https://example.invalid/action',owner.userId,owner.userId,now,now);
  f.sqlite.prepare("INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,version,checkpoint_stage,checkpoint_json,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'url',?,'synthetic-action',?,2,'evidence_ready',?, ?,?,?,?)").run(job,owner.organizationId,project,video,'https://example.invalid/action',action==='retry'?'failed':'pending',JSON.stringify({metadata:{sentinel:true}}),owner.userId,owner.userId,now,now);
  f.runtime.getProjectAccess=async()=>({allowed:true});f.runtime.canWriteProjectAccess=()=>true;
  let signedIn=true;f.mock('lib/request-auth.ts',{readRequestIdentity:async()=>signedIn?{authSubject:owner.userId}:null});
  const invoke=()=>f.load(`app/api/analysis-jobs/[jobId]/${action}/route.ts`).POST(new Request('http://localhost/action',{method:'POST',body:'{}'}),{params:Promise.resolve({jobId:job})});
  const snapshot=()=>Object.fromEntries(['analysis_jobs','analysis_job_events','audit_logs'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return {...f,owner,project,video,job,action,invoke,snapshot,logout:()=>{signedIn=false;}};
}

function beforeWrite(f,action){
  const batch=f.db.batch,prepare=f.db.prepare;let fired=false;const inject=()=>{if(!fired){fired=true;action();}};
  f.db.batch=async statements=>{inject();return batch(statements);};
  f.db.prepare=sql=>{const statement=prepare(sql),run=statement.run;statement.run=async()=>{if(/^\s*(UPDATE|INSERT|DELETE)\b/i.test(sql))inject();return run();};return statement;};
  return ()=>assert.equal(fired,true);
}

for(const action of ['retry','cancel']){
  test(`${action} audit failure leaves state, checkpoint and events unchanged`,async t=>{
    const f=await fixture(t,action),before=f.snapshot();f.sqlite.exec(`CREATE TRIGGER synthetic_action_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='analysis_job.${action==='retry'?'retried':'cancelled'}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    assert.equal((await f.invoke()).status,500);assert.deepEqual(f.snapshot(),before);
  });
  test(`${action} denies project archived at actual commit`,async t=>{
    const f=await fixture(t,action),before=f.snapshot();const injected=beforeWrite(f,()=>f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.project));
    const response=await f.invoke();injected();assert.equal(response.status,403);assert.deepEqual(f.snapshot(),before);
  });
  test(`${action} rechecks logout after reading selected task`,async t=>{
    const f=await fixture(t,action),before=f.snapshot(),prepare=f.db.prepare;
    f.db.prepare=sql=>{const statement=prepare(sql),first=statement.first;statement.first=async()=>{const row=await first();if(sql.includes('FROM analysis_jobs WHERE id = ?'))f.logout();return row;};return statement;};
    assert.equal((await f.invoke()).status,403);assert.deepEqual(f.snapshot(),before);
  });
  test(`${action} lost committed receipt acknowledges actual latest state without duplicate action`,async t=>{
    const f=await fixture(t,action),batch=f.db.batch;let fired=false;
    f.db.batch=async statements=>{const result=await batch(statements);if(!fired){fired=true;throw new Error('synthetic committed receipt lost');}return result;};
    assert.equal((await f.invoke()).status,200);assert.equal(fired,true);const state=f.snapshot();assert.equal(state.analysis_jobs[0].version,3);
    assert.equal(state.audit_logs.filter(row=>row.action===`analysis_job.${action==='retry'?'retried':'cancelled'}`).length,1);
    assert.equal((await f.invoke()).status,409);assert.deepEqual(f.snapshot(),state);
  });
  test(`${action} unreadable receipt reports uncertainty and preserves stored state`,async t=>{
    const f=await fixture(t,action),batch=f.db.batch,prepare=f.db.prepare;let unreadable=false;
    f.db.batch=async statements=>{await batch(statements);unreadable=true;throw new Error('synthetic receipt lost');};f.db.prepare=sql=>{if(unreadable)throw new Error('synthetic read unavailable');return prepare(sql);};
    const response=await f.invoke();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'ANALYSIS_ACTION_STATUS_UNKNOWN');assert.equal(f.snapshot().analysis_jobs[0].version,3);
  });
}

test('retry refuses source deleted at commit instead of resurrecting a hidden task',async t=>{
  const f=await fixture(t),before=f.snapshot();const injected=beforeWrite(f,()=>f.sqlite.prepare('UPDATE videos SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.video));
  const response=await f.invoke();injected();assert.equal(response.status,404);assert.deepEqual(f.snapshot(),before);
});

test('cancel remains possible for a deleted source to stop accepted work',async t=>{
  const f=await fixture(t,'cancel');f.sqlite.prepare('UPDATE videos SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.video);
  assert.equal((await f.invoke()).status,200);assert.equal(f.snapshot().analysis_jobs[0].status,'cancelled');
});

test('cancel event failure rolls back cancellation and audit together',async t=>{
  const f=await fixture(t,'cancel'),before=f.snapshot();f.sqlite.exec("CREATE TRIGGER synthetic_action_event_failure BEFORE INSERT ON analysis_job_events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
  assert.equal((await f.invoke()).status,500);assert.deepEqual(f.snapshot(),before);
});

for(const action of ['retry','cancel']) {
  for(const revoke of ['user-disabled','member-disabled','demoted']) test(`${action} rejects ${revoke} at actual commit`,async t=>{
    const f=await fixture(t,action),before=f.snapshot();
    const injected=beforeWrite(f,()=>{
      if(revoke==='user-disabled') f.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.owner.userId);
      else if(revoke==='member-disabled') f.sqlite.prepare("UPDATE organization_members SET status='disabled' WHERE user_id=?").run(f.owner.userId);
      else f.sqlite.prepare("UPDATE organization_members SET role='member' WHERE user_id=?").run(f.owner.userId);
    });
    const response=await f.invoke();injected();assert.equal(response.status,403);assert.deepEqual(f.snapshot(),before);
  });
  test(`${action} refuses a changed version at commit without adding a marker or event`,async t=>{
    const f=await fixture(t,action),before=f.snapshot();
    const injected=beforeWrite(f,()=>f.sqlite.prepare('UPDATE analysis_jobs SET version=version+1 WHERE id=?').run(f.job));
    const response=await f.invoke();injected();assert.equal(response.status,409);
    before.analysis_jobs[0].version+=1;assert.deepEqual(f.snapshot(),before);
  });
}
test('retry event failure rolls back state, checkpoint and audit',async t=>{
  const f=await fixture(t),before=f.snapshot();f.sqlite.exec("CREATE TRIGGER synthetic_retry_event_failure BEFORE INSERT ON analysis_job_events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END");
  assert.equal((await f.invoke()).status,500);assert.deepEqual(f.snapshot(),before);
});
test('retry reconciles an advanced worker state after the committed acknowledgement is lost',async t=>{
  const f=await fixture(t),batch=f.db.batch;let fired=false;
  f.db.batch=async statements=>{const results=await batch(statements);if(!fired){fired=true;f.sqlite.prepare("UPDATE analysis_jobs SET status='downloading',current_stage='synthetic worker claimed',version=version+1 WHERE id=?").run(f.job);throw new Error('synthetic ack lost after worker claims');}return results;};
  const response=await f.invoke();assert.equal(response.status,200);const state=(await response.json()).job;assert.equal(state.status,'downloading');assert.equal(state.version,4);
  assert.equal(f.snapshot().analysis_job_events.length,1);assert.equal(f.snapshot().analysis_jobs[0].checkpoint_json,JSON.stringify({metadata:{sentinel:true}}));
});
test('cancel response preserves the processing lease and explains pending resource release',async t=>{
  const f=await fixture(t,'cancel'),expires=new Date(Date.now()+60000).toISOString();f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing',lease_owner='synthetic-owner',lease_expires_at=?,progress=87 WHERE id=?").run(expires,f.job);
  const response=await f.invoke();assert.equal(response.status,200);const state=(await response.json()).job;assert.equal(state.progress,87);assert.equal(state.current_stage,'任务已取消，等待释放处理资源');
  const job=f.snapshot().analysis_jobs[0];assert.equal(job.lease_owner,'synthetic-owner');assert.equal(job.lease_expires_at,expires);assert.equal(f.snapshot().analysis_job_events[0].progress,87);
});
