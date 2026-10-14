import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {runtimeFixture} from '../tests/helpers/runtime-fixture.mjs';

// Synthetic, process-isolated in-memory SQLite only. No application server,
// business storage, configuration, network, model or external platform access.
const root=fileURLToPath(new URL('..',import.meta.url)),filename=fileURLToPath(import.meta.url);
const cases={small:{works:100,historyDays:30,periodDays:14,slots:[25,50,100],foreign:true},large:{works:500,historyDays:365,periodDays:14,slots:[25,50,100],foreign:true},capacity:{works:5000,historyDays:1,periodDays:10,slots:[50,100],foreign:false}};
const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const runDir=option('--outdir')||path.join(root,'.local/performance-history',Date.now().toString());
mkdirSync(runDir,{recursive:true});
const caseName=option('--case');
const sampleCount=Number(option('--samples')||5);
assert.ok(Number.isInteger(sampleCount)&&sampleCount>=1&&sampleCount<=5);
const sha=file=>createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex');
const boundary='Synthetic dataset and actual current analytics/report route SQL through Node in-memory SQLite. Process CPU/RSS includes fixture setup, runtime and SQLite; not a Worker/D1 HTTP, disk, deployment capacity, field concurrency or real business benchmark. No model/network calls.';

if(!caseName) {
  const baseline=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(baseline.status,0);
  for(const name of Object.keys(cases)) {
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[filename,'--case',name,'--outdir',runDir,'--samples',String(sampleCount)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill();reject(Error(`Synthetic ${name} case exceeded 120 seconds`));},120000);
      child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error(`${name} exited ${code}`));});
    });
  }
  const sourceStatus=spawnSync('git',['status','--porcelain','--','lib/performance-analytics.ts','lib/performance-visibility.ts','app/api/reports/route.ts'],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(sourceStatus.status,0);
  const report={passed:true,synthetic:true,baseline:baseline.stdout.trim(),sourceUncommitted:Boolean(sourceStatus.stdout.trim()),sourceHashes:['lib/performance-analytics.ts','lib/performance-visibility.ts','app/api/reports/route.ts'].map(file=>({file,sha256:sha(file)})),cases:Object.keys(cases).map(name=>JSON.parse(readFileSync(path.join(runDir,name+'.json'),'utf8'))),boundary};
  writeFileSync(path.join(runDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,evidence:path.join(runDir,'report.json')}));
} else {
  assert.ok(Object.hasOwn(cases,caseName));const parameters=cases[caseName],cleanup=[];
  const f=runtimeFixture({after:callback=>cleanup.push(callback)});
  try {
    const owner=await f.initialize();f.identity.userId=owner.userId;
    const project='history-primary',now='2026-10-14T00:00:00.000Z',cache=new Map();
    function seed(table,values) {
      let columns=cache.get(table+'-columns');if(!columns){columns=new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));cache.set(table+'-columns',columns);}
      const data={id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:project,created_by:owner.userId,updated_by:owner.userId,created_at:now,updated_at:now,...values},entries=Object.entries(data).filter(([key])=>columns.has(key)),key=table+':'+entries.map(([column])=>column).join(',');
      let statement=cache.get(key);if(!statement){statement=f.sqlite.prepare(`INSERT INTO ${table}(${entries.map(([column])=>column)}) VALUES(${entries.map(()=>'?')})`);cache.set(key,statement);}statement.run(...entries.map(([,value])=>value));return data.id;
    }
    seed('projects',{id:project,name:'Synthetic history',client_name:'Synthetic'});
    if(parameters.foreign){seed('organizations',{id:'history-foreign-org',name:'Other synthetic company',slug:'history-foreign-org'});seed('projects',{id:'history-foreign-project',organization_id:'history-foreign-org',name:'Other synthetic scope',client_name:'Synthetic'});}
    const start=Date.UTC(2026,9,1),dayMs=86400000,metric=f.sqlite.prepare('INSERT INTO publication_metric_snapshots(id,organization_id,project_id,publication_id,content_item_id,observed_at,views,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    const scopedRows=parameters.works*(parameters.historyDays+parameters.periodDays*parameters.slots.length),seedStart=performance.now();
    f.sqlite.exec('BEGIN');
    for(const foreign of parameters.foreign?[false,true]:[false]) {
      const org=foreign?'history-foreign-org':owner.organizationId,proj=foreign?'history-foreign-project':project,prefix=foreign?'foreign':'primary';
      for(let i=0;i<parameters.works;i++) {
        const topic=`${prefix}-topic-${i}`,content=`${prefix}-content-${i}`,version=`${prefix}-version-${i}`,publication=`${prefix}-publication-${i}`,scope={organization_id:org,project_id:proj};
        seed('topic_ideas',{...scope,id:topic,title:'Synthetic history '+i,source_type:'manual'});seed('content_items',{...scope,id:content,topic_id:topic,title:'Synthetic history '+i,status:'published'});
        seed('content_versions',{...scope,id:version,content_item_id:content,version:1,generation_mode:'manual',pack_json:'{}',full_script:'Synthetic',short_script:'Synthetic'});
        seed('publication_records',{...scope,id:publication,content_item_id:content,content_version_id:version,platform:'douyin',status:'published',published_at:'2025-01-01T00:00:00Z'});
        let sequence=0;
        const snapshot=(timestamp,views)=>metric.run(`${prefix}-metric-${i}-${sequence++}`,org,proj,publication,content,new Date(timestamp).toISOString(),views,owner.userId,now);
        for(let day=0;day<parameters.historyDays;day++)snapshot(start-(parameters.historyDays-day)*dayMs+18*3600000,(day+1)*100);
        for(let day=0;day<parameters.periodDays;day++)for(let slot=0;slot<parameters.slots.length;slot++)snapshot(start+day*dayMs+(slot+1)*6*3600000,parameters.historyDays*100+day*100+parameters.slots[slot]);
      }
    }
    f.sqlite.exec('COMMIT');
    const periodEnd=new Date(start+(parameters.periodDays-1)*dayMs).toISOString().slice(0,10);
    const analytics=()=>f.load('lib/performance-analytics.ts').loadPerformanceAnalytics(f.db,owner.organizationId,project,'2026-10-01',periodEnd);
    const beforeRows=f.sqlite.prepare('SELECT COUNT(*) n FROM publication_metric_snapshots').get().n,seedMs=performance.now()-seedStart;
    const samples=[],sqlSamples=[];let queryPlan;
    const prepare=f.db.prepare;
    f.db.prepare=sql=>{
      const analyticsSql=/WITH combined AS(?: MATERIALIZED)? \(/.test(sql);
      const statement=prepare(sql);if(!analyticsSql)return statement;
      const bind=statement.bind,all=statement.all;let bindings=[];
      statement.bind=(...values)=>{bindings=values;return bind(...values);};
      statement.all=()=>{
        if(!queryPlan)queryPlan=f.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all(...bindings);
        // runtimeFixture's async .all executes SQLite synchronously before
        // returning its Promise; measure that span, not the other period.
        const started=performance.now(),result=all();sqlSamples.push(Math.round((performance.now()-started)*100)/100);return result;
      };return statement;
    };
    async function measured(action) {
      const cpu=process.cpuUsage(),rssBefore=process.memoryUsage().rss,started=performance.now();const result=await action();const usage=process.cpuUsage(cpu);
      samples.push({elapsedMs:Math.round((performance.now()-started)*100)/100,userCpuMs:Math.round(usage.user/10)/100,systemCpuMs:Math.round(usage.system/10)/100,rssBeforeBytes:rssBefore,rssAfterBytes:process.memoryUsage().rss});return result;
    }
    let evidence;
    if(caseName==='capacity') {
      await measured(async()=>assert.rejects(analytics(),/PERFORMANCE_RESULT_CAPACITY_EXCEEDED/));
      f.runtime.getProjectAccess=async()=>({organizationRole:'admin'});f.runtime.canWriteProjectAccess=()=>true;
      const input={organizationId:owner.organizationId,projectId:project,reportType:'custom',periodStart:'2026-10-01',periodEnd},route=f.load('app/api/reports/route.ts'),request=()=>new Request('http://localhost/reports',{method:'POST',body:JSON.stringify(input)});
      const create=await measured(()=>route.POST(request()));assert.equal(create.status,422);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM performance_reports').get().n,0);
      const id=seed('performance_reports',{report_type:'custom',period_start:input.periodStart,period_end:periodEnd,title:'Retain draft',status:'draft',summary:'Preserve existing draft',metrics_json:'{}',highlights_json:'[]',recommendations_json:'[]',generated_by:owner.userId,generated_at:now});
      const before=f.sqlite.prepare('SELECT * FROM performance_reports WHERE id=?').get(id),refresh=await measured(()=>route.POST(request()));assert.equal(refresh.status,422);assert.deepEqual(f.sqlite.prepare('SELECT * FROM performance_reports WHERE id=?').get(id),before);
      evidence={actualSqlCapacityExceeded:true,createStatus:422,refreshStatus:422,existingDraftRetained:true,potentialDailyRows:parameters.works*(parameters.periodDays+2)};
    } else {
      const validate=result=>{assert.equal(result.summary.views,parameters.works*parameters.periodDays*100);assert.equal(result.summary.contentCount,parameters.works);assert.equal(result.contentPerformance.length,parameters.works);assert.ok(result.contentPerformance.every(row=>row.publicationId.startsWith('primary-')));assert.equal(result.contentPerformance[0].views,(parameters.historyDays+parameters.periodDays)*100);assert.deepEqual(result.series.map(row=>row.views),Array(parameters.periodDays).fill(parameters.works*100));};
      const warmStarted=performance.now();validate(await analytics());const warmMs=performance.now()-warmStarted;
      for(let i=0;i<sampleCount;i++)validate(await measured(analytics));
      const ordered=samples.map(sample=>sample.elapsedMs).sort((a,b)=>a-b);
      evidence={validatedTotalViews:parameters.works*parameters.periodDays*100,foreignDataExcluded:true,coldMs:Math.round(warmMs*100)/100,sampleCount,minMs:ordered[0],medianMs:ordered[Math.floor(ordered.length/2)],maxMs:ordered.at(-1)};
    }
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM publication_metric_snapshots').get().n,beforeRows);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM model_calls').get().n,0);
    const report={passed:true,synthetic:true,case:caseName,node:process.version,sqlite:f.sqlite.prepare('SELECT sqlite_version() version').get().version,sqlMode:'current production SQL',parameters,totalRawSnapshots:beforeRows,scopedRawSnapshots:scopedRows,seedMs:Math.round(seedMs),samples,sqlSamples,queryPlan,lifetimeMaxRssKiB:process.resourceUsage().maxRSS,evidence,rawSnapshotsRetained:true,modelCalls:0,boundary};
    writeFileSync(path.join(runDir,caseName+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({case:caseName,passed:true,totalRawSnapshots:beforeRows,evidence}));
  } finally {for(const callback of cleanup.reverse())await callback();}
}
