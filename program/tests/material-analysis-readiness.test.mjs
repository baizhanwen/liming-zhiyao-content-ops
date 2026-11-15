import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t, analyses = []) {
  const f=runtimeFixture(t),owner=await f.initialize();f.identity.userId=owner.userId;
  const project=crypto.randomUUID(),now=new Date().toISOString();
  f.sqlite.prepare('INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(project,owner.organizationId,'Synthetic','Synthetic',owner.userId,owner.userId,now,now);
  f.runtime.getOrganizationAccess=async()=>({organizationId:owner.organizationId,userId:owner.userId,organizationRole:'admin'});f.runtime.canManageOrganizationVideoLibrary=async()=>true;f.runtime.canAccessOrganizationVideoLibrary=async()=>true;
  f.runtime.getProjectAccess=async()=>({userId:owner.userId,allowed:true});f.runtime.canWriteProjectAccess=()=>true;
  f.runtime.getMediaBucket=()=>({async put(key){return {key};},async delete(){}});
  f.mock('lib/analyzer-readiness.ts',{readAnalyzerReadiness:async()=>({}),analyzerReadinessError:()=>null});
  f.mock('lib/operations.ts',{checkOrganizationQuota:async()=>({allowed:true,current:0,limit:500})});
  let signedIn=true;f.mock("lib/request-auth.ts",{readRequestIdentity:async()=>signedIn?{authSubject:owner.userId}:null});
  const form=new FormData();form.set('organizationId',owner.organizationId);form.set('projectId',project);
  form.set('manifest',JSON.stringify({format:'liming-video-library-package',version:1,entries:[{library:{category:'other',tags:[],notes:null},video:{platform:'upload',sourceType:'upload',sourceHash:'synthetic-readiness',sourceMediaBlobName:'source'},assets:[{blobName:'source',kind:'source_video',filename:'fixture.mp4',contentType:'video/mp4'}],transcripts:[],analyses,metrics:[]}]}));
  form.append('media',new Blob(['synthetic bytes']),'source');
  const response=await f.load('app/api/video-library/transfer/route.ts').POST(new Request('http://localhost/transfer',{method:'POST',body:form}));assert.equal(response.status,200);
  const video=f.sqlite.prepare('SELECT * FROM videos WHERE project_id=?').get(project);
  const jobs=()=>f.sqlite.prepare('SELECT * FROM analysis_jobs WHERE video_id=? ORDER BY created_at DESC').all(video.id);
  const reanalyze=()=>f.load('app/api/videos/[videoId]/reanalyze/route.ts').POST(new Request('http://localhost/reanalyze',{method:'POST',body:JSON.stringify({organizationId:owner.organizationId,projectId:project})}),{params:Promise.resolve({videoId:video.id})});
  return {...f,owner,project,video,jobs,reanalyze,logout:()=>{signedIn=false;}};
}

const report=(passed,date='2024-01-01T00:00:00.000Z')=>({schema_version:'analysis.v7',report_json:JSON.stringify({analysis_meta:{quality_audit:{status:passed?'passed':'degraded',acceptance_passed:passed,completion_status:passed?'complete':'partial',issues:passed?[]:['缺少视觉证据']}}}),created_at:date,updated_at:date});

test('material without report stays unanalysed with no synthetic completed or queued job',async t=>{
  const f=await fixture(t);assert.equal(f.video.status,'pending');assert.match(f.video.error_message,/未包含分析报告/);assert.equal(f.jobs().length,0);
});

test('material without report can explicitly start a new quota-counted analysis',async t=>{
  const f=await fixture(t);assert.equal(f.jobs().length,0);const response=await f.reanalyze();assert.equal(response.status,201);
  assert.equal(f.jobs().length,1);assert.match(f.jobs()[0].idempotency_key,/^reanalyze:/);assert.equal(f.jobs()[0].status,'pending');
});

test('explicit first analysis of imported material cannot bypass monthly quota',async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE organization_settings SET monthly_analysis_quota=0 WHERE organization_id=?').run(f.owner.organizationId);
  assert.equal((await f.reanalyze()).status,429);assert.equal(f.jobs().length,0);
});

test('latest imported v7 quality failure stays partial and cannot resume a quota-exempt import job',async t=>{
  const f=await fixture(t,[report(true,'2020-01-01T00:00:00.000Z'),report(false)]),job=f.jobs()[0];assert.equal(job.status,'partial');assert.equal(job.error_code,'ANALYSIS_PARTIAL');assert.match(job.error_message,/缺少视觉证据/);
  const before=f.jobs();const response=await f.load('app/api/analysis-jobs/[jobId]/retry/route.ts').POST(new Request('http://localhost/retry',{method:'POST'}),{params:Promise.resolve({jobId:job.id})});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'IMPORTED_REPORT_REANALYSIS_REQUIRED');assert.deepEqual(f.jobs(),before);
});

test('passed imported v7 remains a readable completed import',async t=>{
  const f=await fixture(t,[report(false,'2020-01-01T00:00:00.000Z'),report(true)]);assert.equal(f.jobs()[0].status,'completed');assert.equal(f.video.status,'ready');
});

test('v7 report missing its quality audit does not become fully completed by migration',async t=>{
  const f=await fixture(t,[{schema_version:'analysis.v7',report_json:'{}'}]);assert.equal(f.jobs()[0].status,'partial');
});

test('legacy report remains readable without introducing v7 quality requirements',async t=>{
  const f=await fixture(t,[{schema_version:'analysis.v1',report_json:'{"legacy":true}'}]);assert.equal(f.jobs()[0].status,'completed');
  assert.equal(f.jobs()[0].transcript_review_enabled,1);
});

test('imported original transcript report keeps its disabled review choice on reanalysis and export',async t=>{
  const rawReport={analysis_meta:{transcript_review_enabled:false},unified_report:{version:'unified-report.v2',outcome:{manuscript:'original'}}};
  const f=await fixture(t,[{schema_version:'analysis.v12',report_json:JSON.stringify(rawReport),created_at:'2025-01-01T00:00:00Z'}]);
  assert.equal(f.jobs()[0].transcript_review_enabled,0);
  const exported=await f.load('app/api/video-library/transfer/route.ts').GET(new Request(`http://localhost/transfer?organizationId=${f.owner.organizationId}`));
  assert.equal(exported.status,200);
  const exportedReport=JSON.parse((await exported.json()).entries[0].analyses[0].report_json);
  assert.deepEqual(exportedReport,rawReport);
  const response=await f.reanalyze();assert.equal(response.status,201);
  assert.equal((await response.json()).job.transcript_review_enabled,false);
});

test('import infers disabled review from the new original manuscript marker when metadata is absent',async t=>{
  const f=await fixture(t,[{schema_version:'analysis.v12',report_json:JSON.stringify({unified_report:{version:'unified-report.v2',outcome:{manuscript:'original'}}})}]);
  assert.equal(f.jobs()[0].transcript_review_enabled,0);
});

test('latest imported report determines review choice and older raw reports do not override it',async t=>{
  const raw={schema_version:'analysis.v12',report_json:JSON.stringify({analysis_meta:{transcript_review_enabled:false}}),created_at:'2024-01-01T00:00:00Z'};
  const reviewed={schema_version:'analysis.v12',report_json:JSON.stringify({analysis_meta:{transcript_review_enabled:true}}),created_at:'2025-01-01T00:00:00Z'};
  const f=await fixture(t,[reviewed,raw]);assert.equal(f.jobs()[0].transcript_review_enabled,1);
  const f2=await fixture(t,[{...reviewed,created_at:'2024-01-01T00:00:00Z'},{...raw,created_at:'2025-01-01T00:00:00Z'}]);
  assert.equal(f2.jobs()[0].transcript_review_enabled,0);
});

test('public library listing exposes small quality fields and no full report JSON',async t=>{
  const f=await fixture(t,[report(false)]);const response=await f.load('app/api/video-library/route.ts').GET(new Request(`http://localhost/library?organizationId=${f.owner.organizationId}`));assert.equal(response.status,200);
  const entry=(await response.json()).entries[0];assert.ok(entry.analysis_id);assert.equal(entry.analysis_schema_version,'analysis.v7');assert.equal(entry.analysis_acceptance_passed,0);assert.equal(entry.job_status,'partial');assert.equal(entry.is_imported_job,1);assert.equal(entry.report_json,undefined);assert.equal(entry.analysis_report_json,undefined);
});

test('public owned-video listing exposes absent reports and no synthetic completed tasks',async t=>{
  const f=await fixture(t);const response=await f.load('app/api/videos/route.ts').GET(new Request(`http://localhost/videos?organizationId=${f.owner.organizationId}&projectId=${f.project}`));assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.videos[0].analysis_id,null);assert.equal(body.jobs.length,0);
});

test('explicit imported-material analysis rejects permission revoked at SQL commit',async t=>{
  const f=await fixture(t),batch=f.db.batch;
  f.db.batch=async statements=>{f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.project);return batch(statements);};
  assert.equal((await f.reanalyze()).status,403);assert.equal(f.jobs().length,0);
});

test('explicit imported-material analysis rejects source deleted at SQL commit',async t=>{
  const f=await fixture(t),batch=f.db.batch;
  f.db.batch=async statements=>{f.sqlite.prepare('UPDATE videos SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.video.id);return batch(statements);};
  assert.equal((await f.reanalyze()).status,404);assert.equal(f.jobs().length,0);
});

test('explicit imported-material analysis rechecks logout after quota lookup',async t=>{
  const f=await fixture(t);f.mock('lib/operations.ts',{checkOrganizationQuota:async()=>{f.logout();return {allowed:true,current:0,limit:500};}});
  assert.equal((await f.reanalyze()).status,403);assert.equal(f.jobs().length,0);
});

test('explicit analysis refuses a source changed at commit',async t=>{
  const f=await fixture(t),batch=f.db.batch;
  f.db.batch=async statements=>{f.sqlite.prepare('UPDATE videos SET source_url=? WHERE id=?').run('https://example.invalid/changed',f.video.id);return batch(statements);};
  const response=await f.reanalyze();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'VIDEO_SOURCE_CHANGED');assert.equal(f.jobs().length,0);
});

test('explicit analysis refuses a primary media asset deactivated at commit',async t=>{
  const f=await fixture(t),batch=f.db.batch;
  f.db.batch=async statements=>{f.sqlite.prepare("UPDATE media_assets SET status='deleted' WHERE video_id=?").run(f.video.id);return batch(statements);};
  const response=await f.reanalyze();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'SOURCE_UNAVAILABLE');assert.equal(f.jobs().length,0);
});

test('material import and reanalysis preserve the latest report visual mode without altering export',async t=>{
  const pure={analysis_meta:{visual_analysis_mode:'vision_only'}};
  const hybrid={analysis_meta:{visual_analysis_mode:'hybrid'}};
  const entry=(body,date)=>({schema_version:'analysis.v12',report_json:JSON.stringify(body),created_at:date});
  const f=await fixture(t,[entry(pure,'2025-01-01T00:00:00Z'),entry(hybrid,'2024-01-01T00:00:00Z')]);
  assert.equal(f.jobs()[0].visual_analysis_mode,'vision_only');
  const exported=await f.load('app/api/video-library/transfer/route.ts').GET(new Request(`http://localhost/transfer?organizationId=${f.owner.organizationId}`));
  assert.equal(exported.status,200);
  const analyses=(await exported.json()).entries[0].analyses.map(row=>JSON.parse(row.report_json));
  assert.ok(analyses.some(body=>body.analysis_meta.visual_analysis_mode==='vision_only'));
  const response=await f.reanalyze();assert.equal(response.status,201);
  assert.equal((await response.json()).job.visual_analysis_mode,'vision_only');
  const historical=await fixture(t,[entry({},'2025-01-01T00:00:00Z')]);
  assert.equal(historical.jobs()[0].visual_analysis_mode,'hybrid');
});


test('material import keeps the latest explicit sampling level, export stays unchanged, and legacy reports stay unlabelled',async t=>{
  const quick={analysis_meta:{visual_sampling_level:'quick'}};
  const detailed={analysis_meta:{visual_sampling_level:'detailed'}};
  const entry=(body,date)=>({schema_version:'analysis.v12',report_json:JSON.stringify(body),created_at:date});
  const f=await fixture(t,[entry(detailed,'2024-01-01T00:00:00Z'),entry(quick,'2025-01-01T00:00:00Z')]);
  assert.equal(f.jobs()[0].visual_sampling_level,'quick');
  const exported=await f.load('app/api/video-library/transfer/route.ts').GET(new Request(`http://localhost/transfer?organizationId=${f.owner.organizationId}`));
  assert.equal(exported.status,200);
  const reports=(await exported.json()).entries[0].analyses.map(row=>JSON.parse(row.report_json));
  assert.ok(reports.some(body=>body.analysis_meta.visual_sampling_level==='quick'));
  const reanalyzed=await f.reanalyze();assert.equal(reanalyzed.status,201);
  assert.equal((await reanalyzed.json()).job.visual_sampling_level,'quick');
  const legacy={summary:'Historical report with no sampling metadata'};
  const historical=await fixture(t,[entry(quick,'2024-01-01T00:00:00Z'),entry(legacy,'2025-01-01T00:00:00Z')]);
  assert.equal(historical.jobs()[0].visual_sampling_level,null);
  const legacyExport=await historical.load('app/api/video-library/transfer/route.ts').GET(new Request(`http://localhost/transfer?organizationId=${historical.owner.organizationId}`));
  const latest=(await legacyExport.json()).entries[0].analyses.find(row=>row.created_at==='2025-01-01T00:00:00Z');
  assert.deepEqual(JSON.parse(latest.report_json),legacy);
  const fresh=await historical.reanalyze();assert.equal(fresh.status,201);
  assert.equal((await fresh.json()).job.visual_sampling_level,'balanced');
});
