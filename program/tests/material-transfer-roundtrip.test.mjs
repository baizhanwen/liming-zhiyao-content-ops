import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = new Date().toISOString(), source = crypto.randomUUID(), target = crypto.randomUUID();
  const seed = (table, fields) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({id:crypto.randomUUID(),organization_id:owner.organizationId,project_id:source,created_by:owner.userId,updated_by:owner.userId,created_at:now,updated_at:now,...fields}).filter(([key])=>columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)); return row.id;
  };
  for(const id of [source,target]) seed('projects',{id,name:'Synthetic',client_name:'Synthetic'});
  const objects=new Map(), bucket={async put(key,bytes){objects.set(key,new Uint8Array(bytes));return {key};},async delete(key){objects.delete(key);}};
  f.runtime.getMediaBucket=()=>bucket; f.runtime.getOrganizationAccess=async()=>({organizationId:owner.organizationId,userId:owner.userId,organizationRole:'admin'});
  f.runtime.canManageOrganizationVideoLibrary=async()=>true; f.runtime.getProjectAccess=async()=>({allowed:true}); f.runtime.canWriteProjectAccess=()=>true;
  const video=seed('videos',{source_type:'upload',platform:'upload',source_hash:'synthetic-roundtrip',title:'Synthetic',status:'ready',duration_sec:null});
  const bytes=new TextEncoder().encode('synthetic roundtrip bytes'), sha=await f.runtime.sha256Hex(bytes);
  const asset=seed('media_assets',{video_id:video,kind:'source_video',r2_key:'synthetic/source',filename:'fixture.mp4',content_type:'video/mp4',size_bytes:bytes.length,sha256:sha,status:'active'}); objects.set('synthetic/source',bytes);
  const frame=seed('media_assets',{video_id:video,kind:'keyframe',r2_key:'synthetic/frame',filename:'frame.jpg',content_type:'image/jpeg',size_bytes:bytes.length,sha256:sha,status:'active',is_cover:1,quality_score:0.9}); objects.set('synthetic/frame',bytes);
  f.sqlite.prepare('UPDATE videos SET media_asset_id=? WHERE id=?').run(asset,video);
  const entry=seed('video_library_entries',{source_video_id:video,category:'other',tags_json:JSON.stringify(['  原标签  ']),notes:'\n  原备注  \n'});
  seed('video_transcripts',{video_id:video,version:1,language:'zh-CN',source:'asr',full_text:'\n  原始正文\u0000末尾  \n',segments_json:'[]',confidence:null,created_at:'2020-01-01T00:00:00.000Z',updated_at:'2020-02-01T00:00:00.000Z'});
  for(const [index,date] of [[1,'2020-01-01T00:00:00.000Z'],[2,'2024-01-01T00:00:00.000Z']]) seed('video_analyses',{video_id:video,schema_version:'analysis.v1',report_json:JSON.stringify({sentinel:index}),confidence:null,created_at:date,updated_at:date});
  seed('video_metric_snapshots',{video_id:video,source:'manual',plays:null,likes:0,collected_at:'2024-01-02T00:00:00.000Z',created_at:'2024-01-03T00:00:00.000Z'});
  const route=f.load('app/api/video-library/transfer/route.ts');
  const exportEntries = ids=>route.GET(new Request(`http://localhost/transfer?organizationId=${owner.organizationId}${ids?'&entryIds='+ids.join(','):''}`));
  const submit = manifest=>{
    const form=new FormData();form.set('organizationId',owner.organizationId);form.set('projectId',target);form.set('manifest',JSON.stringify(manifest));
    for(const e of manifest.entries) for(const a of e.assets) form.append('media',new Blob([bytes]),a.blobName);
    return route.POST(new Request('http://localhost/transfer',{method:'POST',body:form}));
  };
  const imported=()=>f.sqlite.prepare('SELECT * FROM videos WHERE project_id=?').get(target);
  return {...f,owner,source,target,video,asset,frame,entry,seed,objects,exportEntries,submit,imported};
}

test('export rejects 101 explicitly selected entries without silently truncating',async t=>{
  const f=await fixture(t);const response=await f.exportEntries([f.entry,...Array.from({length:100},()=>crypto.randomUUID())]);assert.equal(response.status,400);
});

test('export refuses missing or deleted selections instead of dropping them',async t=>{
  const f=await fixture(t);assert.equal((await f.exportEntries([f.entry,crypto.randomUUID()])).status,409);
});

test('export/import roundtrip preserves unknown numbers and exact transcript text',async t=>{
  const f=await fixture(t), manifest=await (await f.exportEntries([f.entry])).json(); assert.equal((await f.submit(manifest)).status,200);
  const video=f.imported(), transcript=f.sqlite.prepare('SELECT * FROM video_transcripts WHERE video_id=?').get(video.id), metric=f.sqlite.prepare('SELECT * FROM video_metric_snapshots WHERE video_id=?').get(video.id);
  assert.equal(video.duration_sec,null);assert.equal(transcript.confidence,null);assert.equal(metric.plays,null);assert.equal(metric.likes,0);assert.equal(transcript.full_text,'\n  原始正文\u0000末尾  \n');
  const library=f.sqlite.prepare('SELECT * FROM video_library_entries WHERE source_video_id=?').get(video.id);assert.equal(library.notes,'\n  原备注  \n');assert.deepEqual(JSON.parse(library.tags_json),['  原标签  ']);
});

test('roundtrip preserves analysis chronology so the newest report remains newest',async t=>{
  const f=await fixture(t), manifest=await (await f.exportEntries([f.entry])).json();assert.equal((await f.submit(manifest)).status,200);
  const rows=f.sqlite.prepare('SELECT * FROM video_analyses WHERE video_id=? ORDER BY created_at DESC').all(f.imported().id);
  assert.equal(rows[0].created_at,'2024-01-01T00:00:00.000Z');assert.equal(JSON.parse(rows[0].report_json).sentinel,2);
});

test('roundtrip preserves selected cover and its quality',async t=>{
  const f=await fixture(t), manifest=await (await f.exportEntries([f.entry])).json();assert.equal((await f.submit(manifest)).status,200);
  const cover=f.sqlite.prepare("SELECT * FROM media_assets WHERE video_id=? AND kind='keyframe'").get(f.imported().id);assert.equal(cover.is_cover,1);assert.equal(cover.quality_score,0.9);
});

test('missing primary-asset mapping is rejected before importing any entry',async t=>{
  const f=await fixture(t),manifest=await (await f.exportEntries([f.entry])).json();manifest.entries[0].video.sourceMediaBlobName='missing';
  const before=f.objects.size;assert.equal((await f.submit(manifest)).status,400);assert.equal(f.imported(),undefined);assert.equal(f.objects.size,before);
});

test('oversized transcript refuses import instead of reporting success after clipping it',async t=>{
  const f=await fixture(t),manifest=await (await f.exportEntries([f.entry])).json();manifest.entries[0].transcripts[0].full_text='x'.repeat(2_000_001);
  assert.equal((await f.submit(manifest)).status,400);assert.equal(f.imported(),undefined);
});

test('export/import accepts exactly 100 selected entries using bounded query bindings',async t=>{
  const f=await fixture(t),ids=[f.entry];
  for(let index=1;index<100;index++){
    const video=f.seed('videos',{source_type:'url',platform:'douyin',source_hash:`synthetic-${index}`,source_url:`https://example.invalid/${index}`,status:'ready'});
    ids.push(f.seed('video_library_entries',{source_video_id:video,category:'other',tags_json:'[]'}));
  }
  const prepare=f.db.prepare;
  f.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind;statement.bind=(...values)=>{assert.ok(values.length<=100,'Never exceed 100 query bindings');return bind(...values);};return statement;};
  const response=await f.exportEntries(ids);assert.equal(response.status,200);const manifest=await response.json();assert.equal(manifest.entries.length,100);
  assert.equal((await f.submit(manifest)).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM videos WHERE project_id=?').get(f.target).n,100);
});

test('export refuses a primary asset removed from the active attachment set',async t=>{
  const f=await fixture(t);f.sqlite.prepare("UPDATE media_assets SET status='deleted' WHERE id=?").run(f.asset);
  assert.equal((await f.exportEntries([f.entry])).status,409);
});

test('malformed metadata in a later entry rejects the manifest before any import',async t=>{
  const f=await fixture(t),manifest=await (await f.exportEntries([f.entry])).json(),second=structuredClone(manifest.entries[0]);second.video.sourceHash='second';second.library.tags=['valid',42];manifest.entries.push(second);
  const before=f.objects.size;assert.equal((await f.submit(manifest)).status,400);assert.equal(f.imported(),undefined);assert.equal(f.objects.size,before);
});

test('old v1 package without cover extensions remains importable',async t=>{
  const f=await fixture(t),manifest=await (await f.exportEntries([f.entry])).json();for(const asset of manifest.entries[0].assets){delete asset.isCover;delete asset.qualityScore;}
  assert.equal((await f.submit(manifest)).status,200);const frame=f.sqlite.prepare("SELECT * FROM media_assets WHERE video_id=? AND kind='keyframe'").get(f.imported().id);assert.equal(frame.is_cover,0);assert.equal(frame.quality_score,null);
});
