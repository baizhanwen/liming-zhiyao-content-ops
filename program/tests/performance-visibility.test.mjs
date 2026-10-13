import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f=runtimeFixture(t),owner=await f.initialize(),project=crypto.randomUUID(),now="2026-10-14T00:00:00.000Z";f.identity.userId=owner.userId;
  function seed(table,values){const cols=f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name),data={id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:project,created_by:owner.userId,updated_by:owner.userId,imported_by:owner.userId,created_at:now,updated_at:now,...values},entries=Object.entries(data).filter(([key])=>cols.includes(key));f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key)}) VALUES(${entries.map(()=>"?")})`).run(...entries.map(([,value])=>value));return data.id;}
  seed("projects",{id:project,name:"Synthetic",client_name:"Synthetic"});const topic=seed("topic_ideas",{title:"Synthetic",source_type:"manual"}),content=seed("content_items",{topic_id:topic,title:"Synthetic",status:"published"}),version=seed("content_versions",{content_item_id:content,version:1,generation_mode:"manual",pack_json:"{}",full_script:"合成稿件。",short_script:"合成稿件。"});
  const analytics=()=>f.load("lib/performance-analytics.ts").loadPerformanceAnalytics(f.db,owner.organizationId,project,"2026-10-14","2026-10-15");
  const employee=()=>f.load("lib/employee-work-report.ts").loadEmployeeWorkReport(f.db,{organizationId:owner.organizationId,projectId:project,employeeUserId:owner.userId,employeeName:"Synthetic",periodStart:"2026-10-14",periodEnd:"2026-10-15"});
  function publication(status) {const id=seed("publication_records",{content_item_id:content,content_version_id:version,platform:"douyin",status,published_at:status==="published"?"2026-10-10T00:00:00Z":null});for(const [observed_at,views]of [["2026-10-13T00:00:00Z",0],[now,100]])seed("publication_metric_snapshots",{publication_id:id,content_item_id:content,observed_at,views});return id;}
  function platform(reviewStatus) {const batch=seed("platform_metric_import_batches",{platform:"douyin",as_of_at:now,source_hash:crypto.randomUUID(),status:"completed",row_count:1,accepted_count:1}),work=seed("platform_works",{platform:"douyin",title:"Synthetic work",title_normalized:"synthetic work",published_at:now,review_status:reviewStatus,content_item_id:content});seed("platform_metric_snapshots",{platform:"douyin",work_id:work,import_batch_id:batch,as_of_at:now,views:100000});return work;}
  return {...f,owner,project,seed,analytics,employee,publication,platform};
}

for(const status of ["scheduled","publishing","failed","cancelled","published"])test(`enterprise ${status} registration only counts when published`,async t=>{
  const f=await fixture(t);f.publication(status);const r=await f.analytics(),included=status==="published";
  assert.equal(r.summary.contentCount,included?1:0);assert.equal(r.summary.views,included?100:0);assert.equal(r.contentPerformance.length,included?1:0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM publication_metric_snapshots").get().n,2);
});

for(const status of ["私密","仅自己可见","自见","已通过",null])test(`enterprise and employee use the same visibility scope for ${status}`,async t=>{
  const f=await fixture(t);f.platform(status);const [analytics,employee]=await Promise.all([f.analytics(),f.employee()]),included=status===null||status==="已通过";
  assert.equal(analytics.summary.contentCount,included?1:0);assert.equal(employee.benchmark.cohortSize,included?1:0);assert.equal(employee.summary.attributedPublishedWorks,included?1:0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM platform_metric_snapshots").get().n,1);
});

test("cancelled metrics do not skew public totals or their comparison",async t=>{
  const f=await fixture(t),hidden=f.publication("cancelled"),active=f.publication("published");f.sqlite.prepare("UPDATE publication_metric_snapshots SET views=900000 WHERE publication_id=? AND views=100").run(hidden);
  const r=await f.analytics();assert.equal(r.summary.views,100);assert.deepEqual(r.contentPerformance.map(row=>row.publicationId),[active]);assert.equal(r.comparison.previous.contentCount,1);
});
