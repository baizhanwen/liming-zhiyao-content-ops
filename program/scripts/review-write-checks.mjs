import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

export async function runReviewWriteChecks({db,http,expect,users,runDir}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project},now=new Date().toISOString();
  const topic=crypto.randomUUID(),content=crypto.randomUUID(),version=crypto.randomUUID();
  await db.prepare("INSERT INTO topic_ideas(id,organization_id,project_id,title,source_type,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'Synthetic review','manual',?,?,?,?)").bind(topic,user.org,user.project,user.id,user.id,now,now).run();
  await db.prepare("INSERT INTO content_items(id,organization_id,project_id,topic_id,title,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'Synthetic review','draft',?,?,?,?)").bind(content,user.org,user.project,topic,user.id,user.id,now,now).run();
  await db.prepare("INSERT INTO content_versions(id,organization_id,project_id,content_item_id,version,generation_mode,pack_json,full_script,short_script,created_by,created_at) VALUES(?,?,?,?,1,'manual','{}','合成审核验收稿件。','合成稿件。',?,?)").bind(version,user.org,user.project,content,user.id,now).run();
  const snapshot=async()=>Object.fromEntries(await Promise.all(["content_items","content_reviews","project_memory_items","project_memory_evidence","audit_logs"].map(async table=>{
    const query=table==="content_items"?"id=?":table==="content_reviews"?"content_item_id=?":table==="audit_logs"?"target_id=?":"organization_id=? AND project_id=?";
    return [table,JSON.stringify((await db.prepare(`SELECT * FROM ${table} WHERE ${query} ORDER BY id`).bind(...(table.startsWith("project_memory")?[user.org,user.project]:[content])).all()).results)];
  })));
  const transition=(toStatus,note)=>http(`/api/content-items/${content}/transition`,{user,method:"POST",body:{...scope,expectedVersion:1,toStatus,...(note?{note}:{})}}),outcomes=[];
  async function fault(toStatus,note) {
    const before=await snapshot();
    await db.prepare(`CREATE TRIGGER synthetic_review_audit BEFORE INSERT ON audit_logs WHEN NEW.action='content.status.changed' AND NEW.target_id='${content}' BEGIN SELECT RAISE(ABORT,'synthetic review audit failure'); END`).run();
    try {expect(await transition(toStatus,note),500);assert.deepEqual(await snapshot(),before);outcomes.push({toStatus,rolledBack:true});}
    finally {await db.prepare("DROP TRIGGER synthetic_review_audit").run();}
  }
  await fault("internal_review");expect(await transition("internal_review"),200);
  await fault("internal_revision","Synthetic returned reason");const returned=expect(await transition("internal_revision","Synthetic returned reason"),200);
  assert.ok(returned.memoryCandidate.id);assert.equal((await db.prepare("SELECT COUNT(*) n FROM project_memory_evidence WHERE memory_item_id=?").bind(returned.memoryCandidate.id).first()).n,1);
  expect(await transition("internal_review"),200);await fault("publish_ready");expect(await transition("publish_ready"),200);
  await fault("archived");expect(await transition("archived"),200);
  expect(await http(`/api/content-items/${content}/transition`,{user,method:"POST",body:{...scope,toStatus:"archived"}}),400);
  assert.equal((await db.prepare("SELECT status FROM content_items WHERE id=?").bind(content).first()).status,"archived");
  writeFileSync(path.join(runDir,"review-write.json"),JSON.stringify({passed:true,synthetic:true,outcomes,memoryCandidateId:returned.memoryCandidate.id,missingVersionStatus:400,archived:true,boundary:"Actual built Worker/HTTP/D1 submit, return, approve, archive and candidate evidence; synthetic manually seeded script, no real reviewer/material/model. Deterministic revocation/logout/receipt tests are separate."},null,2));
}
