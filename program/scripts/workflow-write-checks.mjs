import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

// Isolated fixture and actual built HTTP/D1. No model or platform publication.
export async function runWorkflowWriteChecks({db,http,expect,users,runDir}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project},now=new Date().toISOString();
  async function seed(table,values) {
    const columns=(await db.prepare(`PRAGMA table_info(${table})`).all()).results.map(row=>row.name);
    const data={id:crypto.randomUUID(),organization_id:user.org,project_id:user.project,created_by:user.id,updated_by:user.id,created_at:now,updated_at:now,...values},entries=Object.entries(data).filter(([key])=>columns.includes(key));
    await db.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key)}) VALUES(${entries.map(()=>"?")})`).bind(...entries.map(([,value])=>value)).run();return data.id;
  }
  const topic=await seed("topic_ideas",{title:"Synthetic workflow boundaries",source_type:"manual"});
  const content=await seed("content_items",{topic_id:topic,title:"Synthetic workflow boundaries",status:"publish_ready"});
  const version=await seed("content_versions",{content_item_id:content,version:1,generation_mode:"manual",pack_json:"{}",full_script:"合成稿件，仅用于隔离软件验收。",short_script:"合成稿件。"});
  await seed("content_reviews",{content_item_id:content,content_version_id:version,review_stage:"internal",round:1,decision:"approved",requested_by:user.id,requested_at:now,decided_by:user.id,decided_at:now});
  const route=`/api/content-items/${content}`;
  const snapshot=async()=>Object.fromEntries(await Promise.all(["content_items","content_comments","content_schedules","publication_records","published_copy_records","audit_logs"].map(async table=>{
    const key=table==="content_items"?"id":table==="audit_logs"?"target_id":"content_item_id";
    return [table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY id`).bind(content).all()).results)];
  })));
  const outcomes=[];
  async function auditFault(action,send) {
    const before=await snapshot();
    await db.prepare(`CREATE TRIGGER synthetic_workflow_audit BEFORE INSERT ON audit_logs WHEN NEW.action='${action}' AND NEW.target_id='${content}' BEGIN SELECT RAISE(ABORT,'synthetic workflow audit failure'); END`).run();
    try {expect(await send(),500);assert.deepEqual(await snapshot(),before);outcomes.push({action,rolledBack:true});}
    finally {await db.prepare("DROP TRIGGER synthetic_workflow_audit").run();}
  }
  const commentInput={...scope,expectedVersion:1,visibility:"internal",body:"Synthetic comment"};
  await auditFault("content.comment.created",()=>http(route+"/comments",{user,method:"POST",body:commentInput}));
  const comment=expect(await http(route+"/comments",{user,method:"POST",body:commentInput}),201).comment;
  const resolveInput={...scope,resolved:true,expectedUpdatedAt:comment.updated_at};
  await auditFault("content.comment.resolved",()=>http(`/api/content-comments/${comment.id}`,{user,method:"PATCH",body:resolveInput}));
  expect(await http(`/api/content-comments/${comment.id}`,{user,method:"PATCH",body:resolveInput}),200);
  expect(await http(`/api/content-comments/${comment.id}`,{user,method:"PATCH",body:resolveInput}),409);
  const scheduleInput={...scope,expectedVersion:1,expectedUpdatedAt:null,platform:"xiaohongshu",scheduledAt:"2026-10-15T00:00:00Z",timezone:"UTC",status:"planned"};
  await auditFault("content.schedule.saved",()=>http(route+"/schedule",{user,method:"PUT",body:scheduleInput}));
  const schedule=expect(await http(route+"/schedule",{user,method:"PUT",body:scheduleInput}),200).schedule;
  expect(await http(route+"/schedule",{user,method:"PUT",body:scheduleInput}),409);
  const publicationInput={...scope,expectedVersion:1,platform:"douyin",status:"published",externalUrl:"https://example.invalid/workflow-boundaries"};
  await auditFault("content.publication.saved",()=>http(route+"/publications",{user,method:"POST",body:publicationInput}));
  const publication=expect(await http(route+"/publications",{user,method:"POST",body:publicationInput}),200).publication;
  assert.equal(publication.schedule_id,null);
  assert.equal((await db.prepare("SELECT status FROM content_schedules WHERE id=?").bind(schedule.id).first()).status,"planned");
  expect(await http(route+"/publications",{user,method:"POST",body:{...publicationInput,publicationId:publication.id}}),400);
  writeFileSync(path.join(runDir,"workflow-write.json"),JSON.stringify({passed:true,synthetic:true,outcomes,staleResolutionStatus:409,staleScheduleStatus:409,publicationEditWithoutStamp:400,unrelatedSchedulePreserved:true,contentId:content,boundary:"Built Worker/HTTP/D1 with synthetic approved fixture. Audit faults and stale versions are real HTTP; no real review account, external publishing or model. Deterministic overlap/logout/lost receipt tests are separate."},null,2));
}
