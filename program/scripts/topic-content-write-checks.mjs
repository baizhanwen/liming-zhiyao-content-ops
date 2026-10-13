import assert from "node:assert/strict";
import {writeFileSync} from "node:fs";
import path from "node:path";

export async function runTopicContentWriteChecks({db,http,expect,users,runDir}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project},now=new Date().toISOString(),knowledge=[];
  const seed=[];
  for(let i=0;i<20;i++) {
    const id=crypto.randomUUID();knowledge.push(id);
    seed.push(db.prepare("INSERT INTO knowledge_items(id,organization_id,project_id,category,title,status,current_version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'other',?,'confirmed',1,?,?,?,?)").bind(id,user.org,user.project,`Synthetic topic source ${i}`,user.id,user.id,now,now));
    seed.push(db.prepare("INSERT INTO knowledge_item_versions(id,organization_id,project_id,item_id,version,body,source_type,created_by,created_at) VALUES(?,?,?,?,1,?,'manual',?,?)").bind(crypto.randomUUID(),user.org,user.project,id,`Synthetic confirmed knowledge body ${i}`,user.id,now));
  }
  await db.batch(seed);
  const tables=["topic_ideas","topic_citations","content_items","content_versions","content_citations","audit_logs"];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} WHERE organization_id=? AND project_id=? ${table==='audit_logs'?"AND action IN ('topic.created','content.created','topic.deleted')":""} ORDER BY id`).bind(user.org,user.project).all()).results)])));
  const outcomes=[];
  async function fault(table,condition,invoke) {
    const before=await snapshot();
    await db.prepare(`CREATE TRIGGER synthetic_topic_boundary BEFORE INSERT ON ${table} WHEN NEW.organization_id='${user.org}' AND NEW.project_id='${user.project}' AND (${condition}) BEGIN SELECT RAISE(ABORT,'synthetic topic boundary failure'); END`).run();
    try {expect(await invoke(),500);assert.deepEqual(await snapshot(),before);outcomes.push({table,condition,rolledBack:true});}
    finally {await db.prepare("DROP TRIGGER synthetic_topic_boundary").run();}
  }
  const topicBody={...scope,title:"Synthetic topic entry acceptance",sourceKnowledgeItemIds:knowledge};
  const createTopic=()=>http('/api/topics',{user,method:'POST',body:topicBody});
  await fault('audit_logs',"NEW.action='topic.created'",createTopic);
  const topic=expect(await createTopic(),201).topic;
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM topic_citations WHERE topic_id=?').bind(topic.id).first()).n,20);
  const createContent=()=>http('/api/content-items',{user,method:'POST',body:{...scope,topicId:topic.id}});
  await fault('audit_logs',"NEW.action='content.created'",createContent);
  await fault('content_versions','1',createContent);
  const contenders=await Promise.all([createContent(),createContent()]);
  assert.deepEqual(contenders.map(r=>r.status).sort(),[201,409]);
  const content=expect(contenders.find(r=>r.status===201),201).item;
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM content_versions WHERE content_item_id=?').bind(content.id).first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM content_citations WHERE content_item_id=?').bind(content.id).first()).n,21);
  const currentTopic=expect(await http('/api/topics?'+new URLSearchParams(scope),{user}),200).topics.find(row=>row.id===topic.id);assert.ok(currentTopic.updated_at);
  const deleteTopic=extra=>http('/api/topics',{user,method:'DELETE',body:{...scope,topicId:topic.id,confirmationTitle:topic.title,expectedUpdatedAt:currentTopic.updated_at,...extra}});
  // Existing runtime users are members. Verify rejection, then use a temporary
  // isolated administrator fixture for deletion; restore the original role.
  expect(await deleteTopic(),403);
  const priorRole=(await db.prepare('SELECT role FROM organization_members WHERE organization_id=? AND user_id=?').bind(user.org,user.id).first()).role;
  await db.prepare("UPDATE organization_members SET role='admin' WHERE organization_id=? AND user_id=?").bind(user.org,user.id).run();
  try {
    expect(await deleteTopic({expectedUpdatedAt:undefined}),400);
    expect(await deleteTopic({expectedUpdatedAt:'2000-01-01T00:00:00Z'}),409);
    await fault('audit_logs',"NEW.action='topic.deleted'",()=>deleteTopic());
    expect(await deleteTopic(),200);
  } finally {await db.prepare('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?').bind(priorRole,user.org,user.id).run();}
  assert.equal(expect(await http('/api/topics?'+new URLSearchParams(scope),{user}),200).topics.some(row=>row.id===topic.id),false);
  assert.ok(expect(await http('/api/content-items?'+new URLSearchParams(scope),{user}),200).items.some(row=>row.id===content.id));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM content_citations WHERE content_item_id=?').bind(content.id).first()).n,21);
  writeFileSync(path.join(runDir,'topic-content-write.json'),JSON.stringify({passed:true,synthetic:true,topicId:topic.id,contentId:content.id,explicitKnowledgeCount:20,contentCitations:21,concurrentStatuses:[201,409],memberDeleteStatus:403,missingDeleteRevision:400,staleDeleteRevision:409,deletedTopicHidden:true,contentHistoryRetained:true,outcomes,boundary:'Actual built Worker/HTTP/D1 API topic -> scaffold -> versioned soft deletion with twenty explicitly seeded synthetic confirmed sources, audit/child failures and concurrent creation. Isolated member rejection and temporary administrator fixture, original role restored. No real model generation, platform action or business materials. Deterministic revocation/logout/receipt tests are separate.'},null,2));
}
