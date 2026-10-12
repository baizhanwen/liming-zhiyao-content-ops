import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const projectId = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(projectId,owner.organizationId,'Synthetic','Synthetic',owner.userId,owner.userId,now,now);
  f.runtime.getOrganizationAccess = async () => ({ organizationId: owner.organizationId, userId: owner.userId, organizationRole: 'admin' });
  f.runtime.canManageOrganizationVideoLibrary = async () => true; f.runtime.getProjectAccess = async () => ({ allowed: true }); f.runtime.canWriteProjectAccess = () => true;
  const objects = new Map(), bucket = { async put(key,bytes) { objects.set(key,new Uint8Array(bytes)); return { key }; }, async delete(key) { objects.delete(key); } };
  f.runtime.getMediaBucket = () => bucket;
  let signedIn = true; f.mock('lib/request-auth.ts', { readRequestIdentity: async () => signedIn ? { authSubject: owner.userId } : null });
  const form = new FormData(); form.set('organizationId',owner.organizationId); form.set('projectId',projectId);
  const entries = [1,2].map(index => ({ library: { category: 'other', tags: [], notes: null }, video: { platform: 'upload', sourceType: 'upload', sourceHash: `synthetic-transfer-${index}`, title: `Synthetic ${index}`, sourceMediaBlobName: `blob-${index}` }, assets: [{ blobName: `blob-${index}`, kind: 'source_video', filename: `${index}.mp4`, contentType: 'video/mp4' }], transcripts: [], analyses: [{ schema_version: 'analysis.v1', report_json: '{}' }], metrics: [] }));
  for (const index of [1,2]) form.append('media', new Blob([`synthetic-${index}`]), `blob-${index}`);
  form.set('manifest',JSON.stringify({format:'liming-video-library-package',version:1,entries}));
  const request = () => new Request('http://localhost/material-transfer',{method:'POST',body:form});
  const submit = () => f.load('app/api/video-library/transfer/route.ts').POST(request());
  const snapshot = () => Object.fromEntries(['videos','media_assets','video_analyses','analysis_jobs','video_library_entries','audit_logs'].map(table => [table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return { ...f, owner, projectId, objects, bucket, submit, snapshot, form, entries, logout: () => {signedIn=false;} };
}

test('material import lost batch receipt keeps committed media and reports success', async t => {
  const f = await fixture(t), batch = f.db.batch; let lost = false;
  f.db.batch = async statements => { const result = await batch(statements); if (!lost) {lost=true;throw new Error('synthetic lost committed receipt');} return result; };
  const response = await f.submit(); assert.equal(response.status,200); assert.equal((await response.json()).imported,2);
  const state = f.snapshot(); assert.equal(state.videos.length,2); assert.equal(state.media_assets.length,2);
  for (const asset of state.media_assets) assert.ok(f.objects.has(asset.r2_key),'Committed media must remain readable');
});

test('material import failure after one entry reports durable partial progress', async t => {
  const f = await fixture(t);
  f.sqlite.exec("CREATE TRIGGER synthetic_transfer_second_failure BEFORE INSERT ON videos WHEN NEW.title='Synthetic 2' BEGIN SELECT RAISE(ABORT,'synthetic second item failure'); END");
  const response = await f.submit(); assert.equal(response.status,500); const body = await response.json();
  assert.equal(body.progress.imported,1); assert.equal(body.progress.failedEntry,2); assert.equal(body.progress.remaining,1);
  assert.equal(f.snapshot().videos.length,1); assert.equal(f.objects.size,1);
  f.sqlite.exec('DROP TRIGGER synthetic_transfer_second_failure');
  const replay = await f.submit(); assert.equal(replay.status,200); assert.deepEqual(await replay.json(),{imported:1,skipped:1}); assert.equal(f.objects.size,2);
});

test('material upload project revoked during object write creates no business rows', async t => {
  const f = await fixture(t), before = f.snapshot(), put = f.bucket.put;
  f.bucket.put = async (...args) => { const result = await put(...args); f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.projectId); return result; };
  const response = await f.submit(); assert.equal(response.status,403); assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});

test('material upload logout during object write prevents database submission', async t => {
  const f = await fixture(t), before = f.snapshot(), put = f.bucket.put;
  f.bucket.put = async (...args) => { const result = await put(...args); f.logout(); return result; };
  assert.equal((await f.submit()).status,403); assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});

test('material import unreadable receipt preserves objects for reconciliation', async t => {
  const f = await fixture(t), batch = f.db.batch, prepare = f.db.prepare; let unreadable = false;
  f.db.batch = async statements => { await batch(statements); unreadable=true;throw new Error('synthetic lost receipt'); };
  f.db.prepare = sql => { if (unreadable) throw new Error('synthetic database unavailable'); return prepare(sql); };
  const response = await f.submit(); assert.equal(response.status,503); assert.equal((await response.json()).error.code,'MATERIAL_IMPORT_STATUS_UNKNOWN');
  assert.equal(f.snapshot().videos.length,1); assert.equal(f.objects.size,1);
});

test('material import cleanup failure reports retained uncommitted media', async t => {
  const f = await fixture(t); f.db.batch = async () => {throw new Error('synthetic uncommitted batch failure');}; f.bucket.delete = async () => {throw new Error('synthetic cleanup failure');};
  const response = await f.submit(); assert.equal(response.status,503); assert.equal((await response.json()).error.code,'MATERIAL_IMPORT_CLEANUP_PENDING');
  assert.equal(f.snapshot().videos.length,0); assert.equal(f.objects.size,1);
});

test('material import null object-store receipt cannot create dangling media rows', async t => {
  const f = await fixture(t), before = f.snapshot(); f.bucket.put = async () => null;
  const response = await f.submit(); assert.equal(response.status,500); assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});

test('material import object put that stores then throws cleans only uncommitted keys', async t => {
  const f = await fixture(t), put = f.bucket.put, before = f.snapshot();
  f.bucket.put = async (...args) => { await put(...args); throw new Error('synthetic lost R2 receipt'); };
  assert.equal((await f.submit()).status,500); assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});

test('material import SQL guard closes permission change immediately before batch', async t => {
  const f = await fixture(t), before = f.snapshot(), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.projectId); return batch(statements); };
  assert.equal((await f.submit()).status,403); assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});

test('material import revoked during second upload preserves first entry and its object', async t => {
  const f = await fixture(t), put = f.bucket.put; let uploads = 0;
  f.bucket.put = async (...args) => { const result = await put(...args); if (++uploads === 2) f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.projectId); return result; };
  const response = await f.submit(); assert.equal(response.status,403); assert.equal((await response.json()).progress.imported,1);
  assert.equal(f.snapshot().videos.length,1); assert.equal(f.objects.size,1); assert.ok(f.objects.has(f.snapshot().media_assets[0].r2_key));
});

test('material import anonymous request is rejected before touching body', async t => {
  const f = await fixture(t); f.logout();
  const request = { get body() { throw new Error('Body must not be read'); }, formData() { throw new Error('Body must not be parsed'); } };
  assert.equal((await f.load('app/api/video-library/transfer/route.ts').POST(request)).status,401);
});

test('material import excessive child records rejects whole manifest without silent truncation', async t => {
  const f = await fixture(t), before = f.snapshot(); f.entries[1].analyses = Array.from({length:21},() => ({schema_version:'analysis.v1',report_json:'{}'}));
  f.form.set('manifest',JSON.stringify({format:'liming-video-library-package',version:1,entries:f.entries}));
  const response = await f.submit(); assert.equal(response.status,400); assert.equal((await response.json()).error.code,'MATERIAL_RECORD_LIMIT');
  assert.deepEqual(f.snapshot(),before); assert.equal(f.objects.size,0);
});
