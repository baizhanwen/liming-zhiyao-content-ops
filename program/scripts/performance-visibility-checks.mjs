import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";

export async function runPerformanceVisibilityChecks({db,http,expect,users,runDir}) {
  const user=users[0],scope={organizationId:user.org,projectId:user.project};
  const publication=await db.prepare("SELECT id,content_item_id,status,published_at FROM publication_records WHERE organization_id=? AND project_id=? AND status='published' LIMIT 1").bind(user.org,user.project).first();assert.ok(publication);
  const analytics=()=>http('/api/analytics?'+new URLSearchParams({...scope,days:'30'}),{user});
  const before=expect(await analytics(),200);assert.ok(before.contentPerformance.some(work=>work.publicationId===publication.id));
  const metricsBefore=(await db.prepare('SELECT COUNT(*) n FROM publication_metric_snapshots WHERE publication_id=?').bind(publication.id).first()).n;
  try {
    await db.prepare("UPDATE publication_records SET status='cancelled',published_at=NULL WHERE id=?").bind(publication.id).run();
    const cancelled=expect(await analytics(),200);assert.equal(cancelled.contentPerformance.some(work=>work.publicationId===publication.id),false);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM publication_metric_snapshots WHERE publication_id=?').bind(publication.id).first()).n,metricsBefore);
  } finally {await db.prepare('UPDATE publication_records SET status=?,published_at=? WHERE id=?').bind(publication.status,publication.published_at,publication.id).run();}
  const input={...scope,employeeUserId:user.id,reportType:'custom',periodStart:'2026-10-01',periodEnd:'2026-10-15'},initial=expect(await http('/api/employee-reports',{user,method:'POST',body:input}),201).report;
  const initialSnapshot=JSON.parse(initial.snapshot_json),now=new Date().toISOString(),batch=crypto.randomUUID(),work=crypto.randomUUID(),snapshot=crypto.randomUUID();
  await db.prepare("INSERT INTO platform_metric_import_batches(id,organization_id,project_id,platform,as_of_at,source_hash,status,row_count,accepted_count,imported_by,created_at) VALUES(?,?,?,'douyin',?,?,'completed',1,1,?,?)").bind(batch,user.org,user.project,now,crypto.randomUUID(),user.id,now).run();
  await db.prepare("INSERT INTO platform_works(id,organization_id,project_id,platform,title,title_normalized,published_at,review_status,content_item_id,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','Synthetic private work','synthetic private work','2026-10-01T00:00:00Z','私密',?,?,?,?,?)").bind(work,user.org,user.project,publication.content_item_id,user.id,user.id,now,now).run();
  await db.prepare("INSERT INTO platform_metric_snapshots(id,organization_id,project_id,platform,work_id,import_batch_id,as_of_at,views,created_by,created_at) VALUES(?,?,?,'douyin',?,?,?,1000000,?,?)").bind(snapshot,user.org,user.project,work,batch,now,user.id,now).run();
  const current=JSON.parse(expect(await http('/api/employee-reports',{user,method:'POST',body:input}),200).report.snapshot_json);
  assert.equal(current.benchmark.cohortSize,initialSnapshot.benchmark.cohortSize);assert.equal(current.outcomes.some(outcome=>outcome.workId===work),false);
  assert.equal(expect(await analytics(),200).contentPerformance.some(row=>row.publicationId==='platform:'+work),false);
  assert.ok(await db.prepare('SELECT id FROM platform_metric_snapshots WHERE id=?').bind(snapshot).first());
  writeFileSync(path.join(runDir,'performance-visibility.json'),JSON.stringify({passed:true,synthetic:true,cancelledPublicationExcluded:true,retainedStandardSnapshots:metricsBefore,privateWorkExcluded:true,unchangedCohortSize:current.benchmark.cohortSize,privateSnapshotRetained:true,boundary:'Actual built HTTP/D1 and persisted employee report; synthetic status correction and private work. Original status restored, all snapshots retained; no real supplier status, model or platform action.'},null,2));
}
