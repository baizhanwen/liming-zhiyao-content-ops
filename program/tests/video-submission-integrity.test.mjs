import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize();
  f.identity.userId = owner.userId;
  const stamp = new Date().toISOString();
  for (const id of ['source', 'target']) f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, owner.organizationId, id, id, owner.userId, owner.userId, stamp, stamp);
  f.runtime.getProjectAccess = async () => ({ allowed: true });
  f.runtime.canWriteProjectAccess = access => access.allowed;
  f.runtime.hashInvitationToken = async value => f.runtime.sha256Hex(Buffer.from(value));
  let authenticated = true;
  f.mock('lib/request-auth.ts', { readRequestIdentity: async () => authenticated ? { authSubject: owner.userId } : null });
  f.mock('lib/analysis-submission-availability.ts', { checkNewAnalysisAvailability: async () => null });
  const objects = new Map();
  const bucket = { put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); return { key }; }, delete: async key => { objects.delete(key); } };
  f.runtime.getMediaBucket = () => bucket;
  const upload = (project = 'source', bytes = 'synthetic bytes') => {
    const body = new FormData(); body.set('file', new File([bytes], 'synthetic.mp4', { type: 'video/mp4' }));
    return f.load('app/api/videos/upload/route.ts').POST(new Request('http://localhost/api/videos/upload', { method: 'POST', headers: { 'x-organization-id': owner.organizationId, 'x-project-id': project }, body }));
  };
  const url = (project = 'source') => f.load('app/api/videos/from-url/route.ts').POST(new Request('http://localhost/api/videos/from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: owner.organizationId, projectId: project, url: 'https://www.douyin.com/video/1234567890123456789' }) }));
  const counts = () => Object.fromEntries(['videos', 'media_assets', 'video_library_entries', 'analysis_jobs', 'project_video_references', 'audit_logs'].map(table => [table, f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  return { ...f, owner, bucket, objects, upload, url, counts, logout: () => { authenticated = false; } };
}

for (const change of ["UPDATE users SET status='disabled'", "UPDATE organizations SET status='suspended'", "UPDATE organization_members SET status='removed'", "UPDATE projects SET status='archived'", "UPDATE projects SET deleted_at='2026-10-12T00:00:00Z'"]) {
  test(`upload rejects changed scope at database commit: ${change}`, async t => {
    const f = await fixture(t), before = f.counts(), original = f.db.batch;
    f.db.batch = async statements => { f.sqlite.exec(change); return original(statements); };
    const response = await f.upload();
    assert.equal(response.status, 403); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 0);
  });
}
test('upload logout during R2 write prevents records and removes uncommitted bytes', async t => {
  const f = await fixture(t), before = f.counts(), put = f.bucket.put;
  f.bucket.put = async (...args) => { const result = await put(...args); f.logout(); return result; };
  assert.equal((await f.upload()).status, 403); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 0);
});
test('URL submission rechecks permission in its atomic commit', async t => {
  const f = await fixture(t), before = f.counts(), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.exec("UPDATE projects SET status='archived'"); return batch(statements); };
  assert.equal((await f.url()).status, 403); assert.deepEqual(f.counts(), before);
});
test('reuse and its audit roll back together if the audit insert fails', async t => {
  const f = await fixture(t); assert.equal((await f.upload()).status, 202);
  const before = f.counts();
  f.sqlite.exec("CREATE TRIGGER synthetic_reuse_audit BEFORE INSERT ON audit_logs WHEN NEW.action='video.analysis_reused' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.upload('target')).status, 500); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 1);
});
test('canonical source deleted after lookup cannot be imported', async t => {
  const f = await fixture(t); assert.equal((await f.upload()).status, 202);
  const before = f.counts(), prepare = f.db.prepare;
  f.db.prepare = sql => {
    const s = prepare(sql), first = s.first;
    s.first = async () => { const row = await first(); if (sql.includes('AS library_entry_id') && row) f.sqlite.exec("UPDATE videos SET deleted_at='2026-10-12T00:00:00Z'"); return row; };
    return s;
  };
  assert.equal((await f.upload('target')).status, 409); assert.deepEqual(f.counts(), before);
});
test('R2 write plus rejected D1 batch cleans only the new object', async t => {
  const f = await fixture(t); assert.equal((await f.upload()).status, 202);
  const before = f.counts(); f.db.batch = async () => { throw new Error('synthetic unavailable database'); };
  assert.equal((await f.upload('target', 'different media')).status, 500); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 1);
});
test('lost D1 commit receipt keeps referenced media and reports committed submission', async t => {
  const f = await fixture(t), batch = f.db.batch;
  f.db.batch = async statements => { await batch(statements); throw new Error('synthetic lost commit receipt'); };
  const response = await f.upload(); assert.equal(response.status, 202);
  const data = await response.json(); assert.ok(data.video.id && data.job.id);
  const asset = f.sqlite.prepare('SELECT r2_key FROM media_assets WHERE video_id=?').get(data.video.id);
  assert.ok(f.objects.has(asset.r2_key)); assert.equal(f.counts().analysis_jobs, 1);
});
test('unreadable commit result retains bytes and returns explicit uncertainty', async t => {
  const f = await fixture(t), batch = f.db.batch, prepare = f.db.prepare;
  let lost = false;
  f.db.batch = async statements => { await batch(statements); lost = true; throw new Error('synthetic lost receipt'); };
  f.db.prepare = sql => { if (lost) throw new Error('synthetic read unavailable'); return prepare(sql); };
  const response = await f.upload(); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MEDIA_UPLOAD_STATUS_UNKNOWN'); assert.equal(f.objects.size, 1);
});
test('cleanup failure is visible without masking an uncommitted submission', async t => {
  const f = await fixture(t); f.db.batch = async () => { throw new Error('synthetic rejected batch'); };
  f.bucket.delete = async () => { throw new Error('synthetic delete unavailable'); };
  const response = await f.upload(); assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MEDIA_UPLOAD_CLEANUP_PENDING'); assert.equal(f.objects.size, 1); assert.equal(f.counts().videos, 0);
});
test('assigned employee can upload, but project membership revoked at commit prevents another upload', async t => {
  const f = await fixture(t);
  f.sqlite.exec("UPDATE organization_members SET role='employee'");
  f.sqlite.prepare("INSERT INTO project_members(id,organization_id,project_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('assigned',?,'source',?,'member','active',?,?,?,?)").run(f.owner.organizationId, f.owner.userId, f.owner.userId, f.owner.userId, new Date().toISOString(), new Date().toISOString());
  assert.equal((await f.upload()).status, 202);
  const before = f.counts(), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.exec("UPDATE project_members SET status='revoked'"); return batch(statements); };
  assert.equal((await f.upload('source', 'second media')).status, 403); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 1);
});
test('permission revoked after canonical lookup creates neither reference nor audit', async t => {
  const f = await fixture(t); assert.equal((await f.upload()).status, 202);
  const before = f.counts(), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), first = s.first; s.first = async () => { const row = await first(); if (sql.includes('AS library_entry_id') && row) f.sqlite.exec("UPDATE projects SET status='archived' WHERE id='target'"); return row; }; return s; };
  assert.equal((await f.upload('target')).status, 403); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 1);
});
test('R2 null result never creates a dangling database record', async t => {
  const f = await fixture(t), before = f.counts(); f.bucket.put = async () => null;
  assert.equal((await f.upload()).status, 500); assert.deepEqual(f.counts(), before); assert.equal(f.objects.size, 0);
});
