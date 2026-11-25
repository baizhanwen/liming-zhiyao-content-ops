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

test('transfer preserves URL report collection mode and keeps uploads anonymous',async t=>{
  const f=await fixture(t);
  f.sqlite.prepare('UPDATE video_analyses SET report_json=? WHERE video_id=?').run(JSON.stringify({analysis_meta:{collection_mode:'cookie'}}),f.video);
  const manifest=await(await f.exportEntries([f.entry])).json();
  manifest.entries[0].video.sourceType='url'; manifest.entries[0].video.sourceUrl='https://www.douyin.com/video/1234567890123456789';
  assert.equal((await f.submit(manifest)).status,200);
  assert.equal(f.sqlite.prepare('SELECT collection_mode FROM analysis_jobs WHERE video_id=?').get(f.imported().id).collection_mode,'cookie');
  manifest.entries[0].video.sourceType='upload'; manifest.entries[0].video.sourceUrl=null; manifest.entries[0].video.sourceHash='synthetic-second-upload';
  assert.equal((await f.submit(manifest)).status,200);
  const imported=f.sqlite.prepare("SELECT id FROM videos WHERE project_id=? AND source_type='upload'").get(f.target);
  assert.equal(f.sqlite.prepare('SELECT collection_mode FROM analysis_jobs WHERE video_id=?').get(imported.id).collection_mode,'anonymous');
});

test('roundtrip preserves selected cover and its quality',async t=>{
  const f=await fixture(t), manifest=await (await f.exportEntries([f.entry])).json();assert.equal((await f.submit(manifest)).status,200);
  const cover=f.sqlite.prepare("SELECT * FROM media_assets WHERE video_id=? AND kind='keyframe'").get(f.imported().id);assert.equal(cover.is_cover,1);assert.equal(cover.quality_score,0.9);
});

test('roundtrip preserves platform metadata, original cover and metric source independently of selected frames', async t => {
  const f = await fixture(t);
  f.sqlite.prepare(`UPDATE videos SET platform_title=?, platform_description=?, metadata_collected_at=?, published_at_source=? WHERE id=?`)
    .run('Original title', 'Original description', '2026-11-18T00:00:00Z', 'tikhub', f.video);
  const bytes = f.objects.get('synthetic/frame');
  f.seed('media_assets', { video_id: f.video, kind: 'platform_cover', r2_key: 'synthetic/cover', filename: 'platform.jpg',
    content_type: 'image/jpeg', size_bytes: bytes.length, sha256: await f.runtime.sha256Hex(bytes), status: 'active' });
  f.seed('video_metric_snapshots', { video_id: f.video, source: 'tikhub', plays: null, favorites: 0, collected_at: '2026-11-18T00:00:00Z' });
  const manifest = await (await f.exportEntries([f.entry])).json();
  assert.equal((await f.submit(manifest)).status, 200);
  const restored = f.imported();
  assert.equal(restored.platform_title, 'Original title');
  assert.equal(restored.platform_description, 'Original description');
  assert.equal(restored.published_at_source, 'tikhub');
  assert.equal(restored.metadata_collected_at, '2026-11-18T00:00:00Z');
  assert.equal(f.sqlite.prepare("SELECT filename FROM media_assets WHERE video_id=? AND kind='platform_cover'").get(restored.id).filename, 'platform.jpg');
  const metric = f.sqlite.prepare("SELECT plays,favorites FROM video_metric_snapshots WHERE video_id=? AND source='tikhub'").get(restored.id);
  assert.equal(metric.plays, null);
  assert.equal(metric.favorites, 0);
});

test('missing primary-asset mapping is rejected before importing any entry',async t=>{
  const f=await fixture(t),manifest=await (await f.exportEntries([f.entry])).json();manifest.entries[0].video.sourceMediaBlobName='missing';
  const before=f.objects.size;assert.equal((await f.submit(manifest)).status,400);assert.equal(f.imported(),undefined);assert.equal(f.objects.size,before);
});

const commentWorkId = '7512756548356492544';
const authorSecUid = 'MS4wLjABAAAA_fixture_author';
const authorUid = '9007199254740993123';
const commentTime = '2026-11-23T03:15:00.000Z';
const webComments = [
  { comment_id: '7512756548356492549', text: '第一页的第一条', like_count: 0, reply_count: null, published_at: commentTime, has_image: false },
  { comment_id: '7512756548356492548', text: '', like_count: 94, reply_count: 0, published_at: null, has_image: true },
];

test('material packages preserve both, either, or neither Douyin author ID as exact strings', async t => {
  const f = await fixture(t);
  for (const [index, [secUid, uid]] of [[authorSecUid, authorUid], [null, authorUid], [authorSecUid, null], [null, null]].entries()) {
    const workId = String(BigInt(commentWorkId) + BigInt(index));
    f.sqlite.prepare(`UPDATE videos SET platform='douyin', source_type='url', source_hash=?, source_url=?, platform_work_id=?,
      platform_author_sec_uid=?, platform_author_uid=? WHERE id=?`).run(
      'author-' + index, 'https://www.douyin.com/video/' + workId, workId, secUid, uid, f.video,
    );
    const manifest = await (await f.exportEntries([f.entry])).json(), video = manifest.entries[0].video;
    assert.equal(video.platformAuthorSecUid, secUid ?? undefined);
    assert.equal(video.platformAuthorUid, uid ?? undefined);
    assert.equal((await f.submit(manifest)).status, 200);
    const row = f.sqlite.prepare('SELECT platform_author_sec_uid, platform_author_uid FROM videos WHERE project_id=? AND platform_work_id=?').get(f.target, workId);
    assert.equal(row.platform_author_sec_uid, secUid);
    assert.equal(row.platform_author_uid, uid);
  }
});

test('invalid or unbound author IDs are rejected before media are stored', async t => {
  const f = await fixture(t), manifest = await (await f.exportEntries([f.entry])).json();
  const base = { ...manifest.entries[0].video, platform: 'douyin', sourceType: 'url',
    sourceUrl: 'https://www.douyin.com/video/' + commentWorkId, platformWorkId: commentWorkId, platformAuthorSecUid: authorSecUid };
  const objects = f.objects.size;
  for (const fields of [
    { platformAuthorUid: 12345 }, { platformAuthorUid: '1e10' }, { platformAuthorUid: '0' }, { platformAuthorUid: '1'.repeat(26) },
    { platformAuthorSecUid: 'undefined' }, { platformAuthorSecUid: 'a/b/invalid' }, { platformAuthorSecUid: 's'.repeat(257) },
    { platform: 'upload' }, { sourceType: 'upload' }, { platformWorkId: '7196547647351643518' },
    { platformWorkId: null, sourceUrl: 'https://v.douyin.com/abcdef/' },
  ]) {
    manifest.entries[0].video = { ...base, ...fields };
    assert.equal((await f.submit(manifest)).status, 400);
  }
  assert.equal(f.objects.size, objects);
  assert.equal(f.imported(), undefined);
});

test('platform comment sample roundtrips in provider order with exact IDs, including last success after a failed refresh', async t => {
  const f = await fixture(t);
  f.sqlite.prepare(`UPDATE videos SET platform='douyin', source_type='url', source_url=?, platform_work_id=?,
    platform_comments_json=?,platform_comments_collected_at=?,platform_comments_error=? WHERE id=?`)
    .run('https://www.douyin.com/video/' + commentWorkId, commentWorkId, JSON.stringify(webComments), commentTime, '上次采集失败', f.video);
  const read = f.load('lib/video-platform-comments.ts').readVideoPlatformComments;
  const sourceSample = await read(f.db, f.owner.organizationId, f.source, f.video);
  assert.deepEqual(sourceSample, { status: 'failed', error: '上次采集失败', collected_at: commentTime, comments: webComments });
  assert.equal((await read(f.db, f.owner.organizationId, f.target, f.video)).status, 'not_collected');
  const manifest = await (await f.exportEntries([f.entry])).json();
  assert.deepEqual(manifest.entries[0].video.platformComments,
    { source: 'tikhub_douyin_web', platformWorkId: commentWorkId, comments: webComments, collected_at: commentTime });
  assert.equal((await f.submit(manifest)).status, 200);
  const restored = await read(f.db, f.owner.organizationId, f.target, f.imported().id);
  assert.deepEqual(restored, { status: 'available', error: null, collected_at: commentTime, comments: webComments });
});

test('legacy packages omit uncollected comments and an observed empty first page survives transfer', async t => {
  const f = await fixture(t);
  const manifest = await (await f.exportEntries([f.entry])).json();
  const video = manifest.entries[0].video;
  assert.equal('platformComments' in video, false);
  assert.equal((await f.submit(manifest)).status, 200);
  assert.equal(f.imported().platform_comments_json, null);
  Object.assign(video, { platform: 'douyin', sourceType: 'url', sourceHash: 'empty-comments', platformWorkId: commentWorkId,
    sourceUrl: 'https://www.douyin.com/video/' + commentWorkId, platformComments: {
      source: 'tikhub_douyin_web', platformWorkId: commentWorkId, collected_at: commentTime, comments: [],
    } });
  assert.equal((await f.submit(manifest)).status, 200);
  const row = f.sqlite.prepare('SELECT id FROM videos WHERE project_id=? AND platform_work_id=?').get(f.target, commentWorkId);
  const sample = await f.load('lib/video-platform-comments.ts').readVideoPlatformComments(f.db, f.owner.organizationId, f.target, row.id);
  assert.deepEqual(sample, { status: 'available', error: null, collected_at: commentTime, comments: [] });
});

test('import rejects unbounded, malformed or mismatched platform comment samples before writing media', async t => {
  const f = await fixture(t), manifest = await (await f.exportEntries([f.entry])).json();
  const video = manifest.entries[0].video;
  Object.assign(video, { platform: 'douyin', sourceType: 'url', platformWorkId: commentWorkId });
  const good = { source: 'tikhub_douyin_web', platformWorkId: commentWorkId, comments: webComments, collected_at: commentTime };
  const objects = f.objects.size;
  for (const bad of [
    { source: 'unknown' }, { platformWorkId: '7196547647351643518' }, { collected_at: 'not a timestamp' },
    { comments: Array(11).fill(webComments[0]) }, { comments: [webComments[0], webComments[0]] },
    { comments: [{ ...webComments[0], user: { email: 'forbidden@example.invalid' } }] },
    { comments: [{ ...webComments[0], comment_id: 75127 }] }, { comments: [{ ...webComments[0], like_count: -1 }] },
  ]) {
    video.platformComments = { ...good, ...bad };
    assert.equal((await f.submit(manifest)).status, 400);
  }
  assert.equal(f.objects.size, objects);
  assert.equal(f.imported(), undefined);
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


test('export refuses media aggregate above 750 MiB before publishing download links',async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE media_assets SET size_bytes=? WHERE id=?').run(750*1024*1024,f.asset);
  const before=f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n,response=await f.exportEntries([f.entry]);assert.equal(response.status,413);assert.equal((await response.json()).error.code,'MATERIAL_PACKAGE_TOO_LARGE');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n,before);
});
test('export accepts exactly 750 MiB media metadata without downloading or allocating the media',async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE media_assets SET size_bytes=? WHERE id=?').run(750*1024*1024-f.objects.get('synthetic/frame').length,f.asset);assert.equal((await f.exportEntries([f.entry])).status,200);
});
test('UTF-8 report aggregate over 20 million bytes refuses before reading report bodies',async t=>{
  const f=await fixture(t),report=JSON.stringify({payload:'汉'.repeat(1500000)});for(let i=0;i<5;i++)f.seed('video_analyses',{video_id:f.video,schema_version:'analysis.v1',report_json:report,created_at:`2024-02-0${i+1}T00:00:00.000Z`});
  let readBodies=false;const prepare=f.db.prepare;f.db.prepare=sql=>{if(sql.includes('SELECT video_id, schema_version, report_json'))readBodies=true;return prepare(sql);};
  const response=await f.exportEntries([f.entry]);assert.equal(response.status,413);assert.equal((await response.json()).error.code,'MATERIAL_MANIFEST_TOO_LARGE');assert.equal(readBodies,false);
});
test('serialized manifest escaping is included in the UTF-8 byte cap',async t=>{
  const f=await fixture(t),report=JSON.stringify({payload:'\\'.repeat(650000)});for(let i=0;i<8;i++)f.seed('video_analyses',{video_id:f.video,schema_version:'analysis.v1',report_json:report});
  const response=await f.exportEntries([f.entry]);assert.equal(response.status,413);assert.equal((await response.json()).error.code,'MATERIAL_MANIFEST_TOO_LARGE');
});
test('over-limit report count is refused before loading any report body',async t=>{
  const f=await fixture(t);for(let i=0;i<19;i++)f.seed('video_analyses',{video_id:f.video,schema_version:'analysis.v1',report_json:'{}'});
  let readBodies=false;const prepare=f.db.prepare;f.db.prepare=sql=>{if(sql.includes('SELECT video_id, schema_version, report_json'))readBodies=true;return prepare(sql);};
  assert.equal((await f.exportEntries([f.entry])).status,400);assert.equal(readBodies,false);
});


test('oversize escaped manifest is rejected before building the full JSON response',async t=>{
  const f=await fixture(t),report=JSON.stringify({payload:'\\'.repeat(650000)});for(let i=0;i<8;i++)f.seed('video_analyses',{video_id:f.video,schema_version:'analysis.v1',report_json:report});
  const stringify=JSON.stringify;let built=false;
  try {
    JSON.stringify=(value,...rest)=>{if(value?.format==='liming-video-library-package'){built=true;throw Error('synthetic full-response allocation forbidden');}return stringify(value,...rest);};
    const response=await f.exportEntries([f.entry]);assert.equal(response.status,413);assert.equal((await response.json()).error.code,'MATERIAL_MANIFEST_TOO_LARGE');assert.equal(built,false);
  }finally{JSON.stringify=stringify;}
});
test('accepted manifest preserves escaped control text and byte accounting',async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE video_transcripts SET full_text=? WHERE video_id=?').run('原文\0\n😀\ud800',f.video);
  const stored=f.sqlite.prepare('SELECT full_text FROM video_transcripts WHERE video_id=?').get(f.video).full_text;const response=await f.exportEntries([f.entry]);assert.equal(response.status,200);const text=await response.text(),payload=JSON.parse(text);assert.equal(payload.entries[0].transcripts[0].full_text,stored);assert.ok(new TextEncoder().encode(text).length<=20000000);
});
