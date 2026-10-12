import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(), project = crypto.randomUUID(), now = new Date().toISOString();
  f.identity.userId = owner.userId;
  f.sqlite.prepare('INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(project, owner.organizationId, 'Synthetic quota', 'Synthetic', owner.userId, owner.userId, now, now);
  f.runtime.getProjectAccess = async () => ({ allowed: true }); f.runtime.canWriteProjectAccess = () => true;
  f.runtime.hashInvitationToken = value => f.runtime.sha256Hex(new TextEncoder().encode(value));
  f.mock('lib/analyzer-readiness.ts', { readAnalyzerReadiness: async () => ({}), analyzerReadinessError: () => null });
  let arrivals = 0, expected = 0, release, barrier = Promise.resolve();
  f.mock('lib/analysis-submission-availability.ts', { checkNewAnalysisAvailability: async () => { arrivals++; if (arrivals === expected) release?.(); await barrier; return null; } });
  const actualOperations = f.load('lib/operations.ts');
  f.mock('lib/operations.ts', { checkOrganizationQuota: async () => ({ allowed: true, limit: 500, current: 0 }) });
  const objects = new Map(); f.runtime.getMediaBucket = () => ({ put: async (key, bytes) => { objects.set(key, bytes); return { key }; }, delete: async key => { objects.delete(key); } });
  const submit = index => f.load('app/api/videos/from-url/route.ts').POST(new Request('http://localhost/url', { method: 'POST', body: JSON.stringify({ organizationId: owner.organizationId, projectId: project, url: `https://www.douyin.com/video/${1234567890123400000n + BigInt(index)}` }) }));
  const upload = index => { const body = new FormData(); body.set('file', new File([`data-${index}`], 'synthetic.mp4', { type: 'video/mp4' })); return f.load('app/api/videos/upload/route.ts').POST(new Request('http://localhost/upload', { method: 'POST', headers: { 'x-organization-id': owner.organizationId, 'x-project-id': project }, body })); };
  const capacity = (analyses, bytes) => f.sqlite.prepare('UPDATE organization_settings SET monthly_analysis_quota=?,storage_quota_bytes=? WHERE organization_id=?').run(analyses, bytes, owner.organizationId);
  const count = table => f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const media = (id, bytes, status = 'active', kind = 'source_video') => f.sqlite.prepare('INSERT INTO media_assets(id,organization_id,project_id,kind,r2_key,filename,content_type,size_bytes,sha256,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner.organizationId, project, kind, `synthetic/${id}`, 'synthetic', 'video/mp4', bytes, '0'.repeat(64), status, owner.userId, owner.userId, now, now);
  return { ...f, owner, project, now, objects, submit, upload, capacity, count, media, actualOperations, synchronize: n => { expected = n; arrivals = 0; barrier = new Promise(r => { release = r; }); } };
}

test('two URL submissions passing preflight compete for the final monthly slot', async t => {
  const f = await fixture(t); f.capacity(1, 1000); f.synchronize(2);
  const responses = await Promise.all([f.submit(1), f.submit(2)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 429]);
  assert.equal((await responses.find(r => r.status === 429).json()).error.code, 'ANALYSIS_QUOTA_EXCEEDED');
  assert.equal(f.count('videos'), 1); assert.equal(f.count('analysis_jobs'), 1); assert.equal(f.count('video_library_entries'), 1);
});
test('two uploads passing preflight cannot exceed remaining storage; rejected R2 bytes are removed', async t => {
  const f = await fixture(t); f.capacity(500, 6); f.synchronize(2);
  const responses = await Promise.all([f.upload(1), f.upload(2)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [202, 429]);
  assert.equal((await responses.find(r => r.status === 429).json()).error.code, 'STORAGE_QUOTA_EXCEEDED');
  assert.equal(f.count('media_assets'), 1); assert.equal(f.count('analysis_jobs'), 1); assert.equal(f.objects.size, 1);
});
test('quota reduced during R2 write rejects the whole new submission', async t => {
  const f = await fixture(t); f.capacity(1, 1000); const bucket = f.runtime.getMediaBucket(), put = bucket.put;
  bucket.put = async (...args) => { const result = await put(...args); f.capacity(0, 1000); return result; }; f.runtime.getMediaBucket = () => bucket;
  const response = await f.upload(3); assert.equal(response.status, 429);
  assert.equal(f.count('media_assets'), 0); assert.equal(f.count('videos'), 0); assert.equal(f.count('analysis_jobs'), 0); assert.equal(f.objects.size, 0);
});
test('existing-job retry does not consume another monthly creation slot; new reanalysis does', async t => {
  const f = await fixture(t), first = await (await f.submit(1)).json(); f.capacity(1, 1000);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed' WHERE id=?").run(first.job.id);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='pending' WHERE id=?").run(first.job.id);
  assert.equal(f.count('analysis_jobs'), 1);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='completed' WHERE id=?").run(first.job.id);
  const response = await f.load('app/api/videos/[videoId]/reanalyze/route.ts').POST(new Request('http://localhost/reanalyze', { method: 'POST', body: JSON.stringify({ organizationId: f.owner.organizationId, projectId: f.project }) }), { params: Promise.resolve({ videoId: first.video.id }) });
  assert.equal(response.status, 429); assert.equal(f.count('analysis_jobs'), 1);
});
test('manual correction plus reanalysis rolls back the transcript when monthly quota is full', async t => {
  const f = await fixture(t), first = await (await f.submit(1)).json(); f.capacity(1, 1000); f.sqlite.exec("UPDATE analysis_jobs SET status='completed'");
  const response = await f.load('app/api/videos/[videoId]/transcript/route.ts').POST(new Request('http://localhost/transcript', { method: 'POST', body: JSON.stringify({ organizationId: f.owner.organizationId, projectId: f.project, segments: [{ startMs: 0, endMs: 1000, text: 'Synthetic correction' }], reanalyze: true }) }), { params: Promise.resolve({ videoId: first.video.id }) });
  assert.equal(response.status, 429); assert.equal(f.count('video_transcripts'), 0); assert.equal(f.count('analysis_jobs'), 1);
});
test('artifact storage, activation and growth obey quota but shrinking and metadata links remain allowed', async t => {
  const f = await fixture(t); f.capacity(500, 6); f.media('one', 6); f.media('inactive', 1, 'deleted');
  assert.throws(() => f.media('output', 1, 'active', 'keyframe'), /MEDIA_STORAGE_QUOTA_EXCEEDED/);
  assert.throws(() => f.sqlite.exec("UPDATE media_assets SET status='active' WHERE id='inactive'"), /MEDIA_STORAGE_QUOTA_EXCEEDED/);
  assert.throws(() => f.sqlite.exec("UPDATE media_assets SET size_bytes=7 WHERE id='one'"), /MEDIA_STORAGE_QUOTA_EXCEEDED/);
  f.capacity(500, 1); f.sqlite.exec("UPDATE media_assets SET filename='changed' WHERE id='one'"); f.sqlite.exec("UPDATE media_assets SET size_bytes=5 WHERE id='one'");
  assert.equal(f.sqlite.prepare("SELECT size_bytes FROM media_assets WHERE id='one'").get().size_bytes, 5);
});
test('invalid media sizes cannot credit or bypass storage usage', async t => {
  const f = await fixture(t); f.capacity(500, 6);
  for (const value of [-1, 0.5, 'invalid']) assert.throws(() => f.media(crypto.randomUUID(), value), /MEDIA_SIZE_INVALID/);
  assert.equal(f.count('media_assets'), 0);
});
async function artifactFixture(t) {
  const f = await fixture(t), created = await (await f.submit(1)).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status='extracting',version=1,lease_owner='synthetic-worker',lease_expires_at=? WHERE id=?").run(new Date(Date.now() + 60000).toISOString(), created.job.id);
  f.mock('lib/service-auth.ts', { requireAnalyzerService: async () => ({}), normalizeWorkerId: value => value });
  const artifact = () => f.load('app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts').POST(new Request('http://localhost/artifact', { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-id': 'synthetic-worker', 'x-job-version': '1', 'x-artifact-kind': 'report', 'x-artifact-filename': 'synthetic.json' }, body: '{}' }), { params: Promise.resolve({ jobId: created.job.id }) });
  return { ...f, created, artifact };
}
test('artifact rejected by storage quota preserves other rows and removes only its uncommitted bytes', async t => {
  const f = await artifactFixture(t); f.capacity(500, 1);
  const response = await f.artifact(); assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'STORAGE_QUOTA_EXCEEDED'); assert.equal(f.count('media_assets'), 0); assert.equal(f.objects.size, 0);
});
test('artifact lost commit receipt keeps referenced bytes and returns committed asset', async t => {
  const f = await artifactFixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), run = s.run; s.run = async () => { const result = await run(); if (sql.includes('INSERT INTO media_assets')) throw new Error('synthetic lost artifact receipt'); return result; }; return s; };
  const response = await f.artifact(); assert.equal(response.status, 201);
  const data = await response.json(), row = f.sqlite.prepare('SELECT r2_key FROM media_assets WHERE id=?').get(data.asset.id);
  assert.ok(f.objects.has(row.r2_key));
});
test('artifact cannot be saved after its lease is cancelled during R2 put', async t => {
  const f = await artifactFixture(t), bucket = f.runtime.getMediaBucket(), put = bucket.put;
  bucket.put = async (...args) => { const result = await put(...args); f.sqlite.exec("UPDATE analysis_jobs SET status='cancelled'"); return result; }; f.runtime.getMediaBucket = () => bucket;
  assert.equal((await f.artifact()).status, 409); assert.equal(f.count('media_assets'), 0); assert.equal(f.objects.size, 0);
});
test('material imports do not consume current analysis quota; normal creations do', async t => {
  const f = await fixture(t), first = await (await f.submit(1)).json();
  f.sqlite.prepare("UPDATE analysis_jobs SET status='completed',idempotency_key='material-import:synthetic' WHERE id=?").run(first.job.id);
  f.capacity(1, 1000);
  assert.equal((await f.actualOperations.readOrganizationUsage(f.owner.organizationId)).analyses, 0);
  assert.equal((await f.submit(2)).status, 202);
  assert.equal((await f.actualOperations.readOrganizationUsage(f.owner.organizationId)).analyses, 1);
  assert.equal((await f.submit(3)).status, 429);
});
test('new-task accepted timestamp uses the database clock, not an old request timestamp', async t => {
  const f = await fixture(t), submissionModule = f.load('lib/video-submission.ts');
  f.capacity(1, 1000);
  const old = '2020-01-01T00:00:00.000Z';
  const input = { organizationId: f.owner.organizationId, projectId: f.project, userId: f.owner.userId, now: old, sourceType: 'url', sourceUrl: 'https://example.invalid/old', sourceHash: 'old', videoId: crypto.randomUUID(), jobId: crypto.randomUUID(), title: 'Synthetic', analysisProfile: 'standard', auditMetadata: {} };
  await f.db.batch(submissionModule.newVideoSubmissionStatements(f.db, input));
  assert.notEqual(f.sqlite.prepare('SELECT created_at FROM analysis_jobs WHERE id=?').get(input.jobId).created_at, old);
  assert.equal((await f.actualOperations.readOrganizationUsage(f.owner.organizationId)).analyses, 1);
  assert.equal((await f.submit(2)).status, 429);
});
test('the additive quota migration leaves preexisting over-quota rows and configuration unchanged', async t => {
  const f = await fixture(t);
  f.sqlite.exec('DROP TRIGGER analysis_monthly_insert_limit; DROP TRIGGER media_storage_insert_limit; DROP TRIGGER media_storage_update_limit; DROP INDEX analysis_jobs_org_created_idx; DROP INDEX media_assets_org_status_size_idx;');
  f.capacity(0, 1); f.media('legacy-over-quota', 100); assert.equal((await f.submit(1)).status, 202);
  const snapshot = () => Object.fromEntries(['users','organization_settings','videos','analysis_jobs','media_assets','audit_logs'].map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table}`).all()]));
  const before = snapshot();
  const { readFileSync } = await import('node:fs');
  f.sqlite.exec(readFileSync(new URL('../drizzle/0051_organization_analysis_storage_limits.sql', import.meta.url), 'utf8'));
  assert.deepEqual(snapshot(), before); assert.equal((await f.submit(2)).status, 429); assert.equal(f.count('analysis_jobs'), 1);
});
test('an unreadable artifact commit result preserves bytes and reports uncertainty', async t => {
  const f = await artifactFixture(t), prepare = f.db.prepare; let committed = false;
  f.db.prepare = sql => { if (committed) throw new Error('synthetic database read unavailable'); const s = prepare(sql), run = s.run; s.run = async () => { const result = await run(); if (sql.includes('INSERT INTO media_assets')) { committed = true; throw new Error('synthetic lost receipt'); } return result; }; return s; };
  const response = await f.artifact(); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'MEDIA_UPLOAD_STATUS_UNKNOWN'); assert.equal(f.objects.size, 1);
});
