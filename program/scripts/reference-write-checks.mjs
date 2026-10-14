import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

export async function runReferenceWriteChecks({db,http,expect,users,runDir}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project},query=new URLSearchParams(scope),outcomes=[];
  const tables=['knowledge_items','knowledge_item_versions','content_strategies','audit_logs'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} WHERE organization_id=? AND project_id=? ORDER BY id`).bind(user.org,user.project).all()).results)])));
  async function fault(table,condition,invoke){
    const before=await snapshot();await db.prepare(`CREATE TRIGGER synthetic_reference_fault BEFORE INSERT ON ${table} WHEN NEW.organization_id='${user.org}' AND NEW.project_id='${user.project}' AND (${condition}) BEGIN SELECT RAISE(ABORT,'synthetic reference failure'); END`).run();
    try{expect(await invoke(),500);assert.deepEqual(await snapshot(),before);outcomes.push({table,condition,rolledBack:true});}
    finally{await db.prepare('DROP TRIGGER synthetic_reference_fault').run();}
  }
  const knowledgeBody={...scope,title:'Synthetic reference acceptance',category:'other',body:'Synthetic reference body retained in isolated acceptance.',sourceType:'manual'};
  const create=()=>http('/api/knowledge',{user,method:'POST',body:knowledgeBody});
  await fault('audit_logs',"NEW.action='knowledge.created'",create);
  await fault('knowledge_item_versions','1',create);
  const item=expect(await create(),201).item;
  const revision=row=>({expectedVersion:row.current_version??row.version,expectedUpdatedAt:row.updated_at});
  const confirm=extra=>http(`/api/knowledge/${item.id}/confirm`,{user,method:'POST',body:{...scope,...revision(item),...extra}});
  expect(await confirm({expectedVersion:undefined}),400);
  await fault('audit_logs',"NEW.action='knowledge.confirmed'",()=>confirm());
  const confirmed=expect(await confirm(),200).item;assert.ok(confirmed.updated_at!==item.updated_at);
  const patchBody={...knowledgeBody,...revision(confirmed),body:'Synthetic version two retains version one and needs confirmation.'};
  const edit=body=>http(`/api/knowledge/${item.id}?${query}`,{user,method:'PATCH',body});
  await fault('audit_logs',"NEW.action='knowledge.version_created'",()=>edit(patchBody));
  const versionTwo=expect(await edit(patchBody),201).item;assert.equal(versionTwo.current_version,2);assert.equal(versionTwo.status,'draft');
  expect(await edit(patchBody),409);expect(await confirm(),409);
  const archive=body=>http(`/api/knowledge/${item.id}?${query}`,{user,method:'DELETE',body});
  expect(await archive(revision(confirmed)),409);
  await fault('audit_logs',"NEW.action='knowledge.archived'",()=>archive(revision(versionTwo)));
  expect(await archive(revision(versionTwo)),200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM knowledge_item_versions WHERE item_id=?').bind(item.id).first()).n,2);
  const strategyBody={...scope,name:'Synthetic reference strategy',positioning:'Synthetic reference position',targetAudience:'Synthetic audience',painPoints:['Question'],pillars:['Education'],objectives:['education'],topicMix:[{pillar:'Education',ratio:100}]};
  const createStrategy=()=>http('/api/strategies',{user,method:'POST',body:strategyBody});
  await fault('audit_logs',"NEW.action='strategy.created'",createStrategy);
  const created=await Promise.all([createStrategy(),createStrategy()]);created.forEach(result=>expect(result,201));
  const strategies=created.map(result=>result.data.strategy);assert.equal(new Set(strategies.map(row=>row.version)).size,2);
  for(const row of strategies){const audit=await db.prepare("SELECT metadata_json FROM audit_logs WHERE target_id=? AND action='strategy.created'").bind(row.id).first();assert.equal(JSON.parse(audit.metadata_json).version,row.version);}
  const target=strategies[0],activate=extra=>http(`/api/strategies/${target.id}/activate`,{user,method:'POST',body:{...scope,...revision(target),...extra}});
  expect(await activate({expectedUpdatedAt:'2000-01-01T00:00:00Z'}),409);
  await fault('audit_logs',"NEW.action='strategy.activated'",()=>activate());
  const active=expect(await activate(),200).strategy;assert.equal(active.status,'active');
  const beforeRepeat=await snapshot();assert.equal(expect(await activate(),200).idempotent,true);assert.deepEqual(await snapshot(),beforeRepeat);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM content_strategies WHERE organization_id=? AND project_id=? AND status='active'").bind(user.org,user.project).first()).n,1);
  writeFileSync(path.join(runDir,'reference-write.json'),JSON.stringify({passed:true,synthetic:true,knowledgeId:item.id,versionsRetained:2,staleEditConfirmArchiveStatus:409,concurrentStrategyStatuses:[201,201],strategyVersions:strategies.map(row=>row.version),auditVersionsMatch:true,activationIdempotent:true,outcomes,boundary:'Actual built Worker/HTTP/D1 with isolated synthetic member and scope, audit/version insert SQL failures, stale versions and simultaneous strategy creation. Lost acknowledgement and entry races use separate deterministic tests; no real model or business data.'},null,2));
}
