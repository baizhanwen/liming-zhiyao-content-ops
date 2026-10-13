import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

export async function runContentGenerationOwnershipChecks({db,http,expect,users,runDir,setGateway}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project},now=new Date().toISOString();
  const existingStrategy=await db.prepare("SELECT id,objectives_json FROM content_strategies WHERE organization_id=? AND project_id=? AND status='active'").bind(user.org,user.project).first();
  if(!existingStrategy) {
    await db.prepare("INSERT INTO content_strategies(id,organization_id,project_id,version,name,status,positioning,target_audience,pain_points_json,pillars_json,topic_mix_json,objectives_json,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,1,'Synthetic generation strategy','active','Synthetic positioning','Synthetic audience','[]','[]','{}',?, ?,?,?,?)").bind(crypto.randomUUID(),user.org,user.project,JSON.stringify(['education']),user.id,user.id,now,now).run();
  }
  const topic=expect(await http('/api/topics',{user,method:'POST',body:{...scope,title:'Synthetic generation ownership'}}),201).topic;
  const content=expect(await http('/api/content-items',{user,method:'POST',body:{...scope,topicId:topic.id}}),201).item;
  const generate=()=>http(`/api/content-items/${content.id}/generate`,{user,method:'POST',body:{...scope,expectedVersion:1,writingIntent:'auto',creationMode:'standard',benchmarkEntryIds:[],recommendedBenchmarkIds:[]}});
  let enter,release,calls=0;
  const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  setGateway(async()=>{calls++;if(calls===1){enter();await gate;}return Response.json({usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20},choices:[{message:{content:''}}]});});
  const needsObjective=existingStrategy&&(!existingStrategy.objectives_json.trim()||existingStrategy.objectives_json==='[]');
  try {
    if(needsObjective)await db.prepare('UPDATE content_strategies SET objectives_json=? WHERE id=?').bind(JSON.stringify(['education']),existingStrategy.id).run();
    const pending=generate();
    await Promise.race([entered,pending.then(response=>{throw Error('Synthetic gateway was not entered: '+JSON.stringify({status:response.status,data:response.data}));})]);
    const busy=expect(await generate(),409);assert.equal(busy.error.code,'CONTENT_GENERATION_IN_PROGRESS');assert.equal(calls,1);
    const root=await db.prepare("SELECT id FROM model_calls WHERE organization_id=? AND project_id=? AND topic_id=? AND task_type='content_draft' AND status='started'").bind(user.org,user.project,topic.id).first();assert.ok(root);
    // The real startup recovery SQL is exercised separately under its locks.
    // Here a targeted isolated change reproduces its terminal model state.
    await db.prepare("UPDATE model_calls SET status='failed',error_code='WEB_PROCESS_INTERRUPTED',error_message='Synthetic recovered owner',completed_at=? WHERE id=?").bind(now,root.id).run();
    release();
    assert.equal(expect(await pending,409).error.code,'MODEL_REQUEST_INTERRUPTED');assert.equal(calls,1);
    const recovered=await db.prepare('SELECT status,error_code,output_json FROM model_calls WHERE id=?').bind(root.id).first();
    assert.equal(recovered.status,'failed');assert.equal(recovered.error_code,'WEB_PROCESS_INTERRUPTED');assert.equal(JSON.parse(recovered.output_json).modelRequests[0].totalTokens,20);
    assert.equal((await db.prepare('SELECT current_version FROM content_items WHERE id=?').bind(content.id).first()).current_version,1);
    assert.equal(expect(await generate(),502).error.code,'MODEL_EMPTY_RESPONSE');assert.equal(calls,3);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM model_calls WHERE topic_id=? AND status='started'").bind(topic.id).first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM model_calls WHERE topic_id=?').bind(topic.id).first()).n,3);
    writeFileSync(path.join(runDir,'content-generation-ownership.json'),JSON.stringify({passed:true,synthetic:true,topicId:topic.id,contentId:content.id,busyStatus:409,busyProviderRequests:0,recoveredStatus:409,syntheticGatewayRequests:calls,knownTokensPerRequest:20,retainedVersion:1,explicitRetryAccepted:true,paidProviderCalls:0,externalNetworkCalls:0,boundary:'Actual built Worker/HTTP/D1, controlled in-process model gateway held while second request competes. Targeted isolated recovery state, late failed response retains usage, then intentional retry has two bounded empty-response attempts. No actual provider, business material, final-commit interruption or real billing; the commit window is tested separately.'},null,2));
  } finally {
    release();setGateway(null);
    if(needsObjective)await db.prepare('UPDATE content_strategies SET objectives_json=? WHERE id=?').bind(existingStrategy.objectives_json,existingStrategy.id).run();
  }
}
