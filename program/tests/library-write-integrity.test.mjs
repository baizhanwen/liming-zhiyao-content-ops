import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = new Date().toISOString(), target = crypto.randomUUID(), source = crypto.randomUUID();
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, project_id: source, created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); return row.id;
  };
  for (const id of [source, target]) seed('projects', { id, name: 'Synthetic', client_name: 'Synthetic' });
  const entries = [1, 2].map(index => { const video = seed('videos', { platform: 'douyin', source_type: 'url', source_url: `https://example.invalid/${index}`, source_hash: `synthetic-${index}`, status: 'ready' }); return { id: seed('video_library_entries', { source_video_id: video, category: 'other', tags_json: '[]' }), video }; });
  f.runtime.getProjectAccess = async () => ({ allowed: true }); f.runtime.canWriteProjectAccess = () => true;
  f.runtime.getOrganizationAccess = async () => ({ organizationId: owner.organizationId, userId: owner.userId, organizationRole: 'admin' }); f.runtime.canManageOrganizationVideoLibrary = async () => true;
  let signedIn = true; f.mock('lib/request-auth.ts', { readRequestIdentity: async () => signedIn ? { authSubject: owner.userId } : null });
  const request = (method, body) => new Request('http://localhost/library', { method, body: JSON.stringify({ organizationId: owner.organizationId, projectId: target, ...body }) });
  const importEntries = (ids = entries.map(e => e.id)) => f.load('app/api/video-library/references/route.ts').POST(request('POST', { entryIds: ids }));
  const remove = id => f.load('app/api/video-library/references/route.ts').DELETE(request('DELETE', { referenceId: id }));
  const edit = (expectedUpdatedAt = f.sqlite.prepare("SELECT updated_at FROM video_library_entries WHERE id=?").get(entries[0].id).updated_at) => f.load('app/api/video-library/route.ts').PATCH(request('PATCH', { entryId: entries[0].id, expectedUpdatedAt, category: 'benchmark', tags: ['synthetic'], notes: 'changed' }));
  const snapshot = () => Object.fromEntries(['project_video_references','project_memory_events','video_library_entries','audit_logs'].map(table => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return { ...f, owner, source, target, entries, seed, importEntries, remove, edit, snapshot, logout: () => { signedIn = false; } };
}

// Inject immediately before the first actual write in both the old standalone
// implementation and the new batch. A fixture that never fires is a test error.
function beforeCommit(f, action) {
  const prepare = f.db.prepare, batch = f.db.batch; let fired = false;
  const inject = () => { if (!fired) { fired = true; action(); } };
  f.db.batch = async statements => { inject(); return batch(statements); };
  f.db.prepare = sql => { const statement = prepare(sql), run = statement.run;
    statement.run = async () => { if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) inject(); return run(); }; return statement;
  };
  return () => assert.equal(fired, true, 'The concurrency injection must reach the real write');
}

test('import audit failure cannot leave project references', async t => {
  const f = await fixture(t), before = f.snapshot(); f.sqlite.exec("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON audit_logs WHEN NEW.action='video_library.imported' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.importEntries()).status, 500); assert.deepEqual(f.snapshot(), before);
});
test('deleted source and nonexistent IDs reject the complete selected batch', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE videos SET deleted_at=? WHERE id=?').run(new Date().toISOString(), f.entries[0].video);
  const before = f.snapshot(); assert.equal((await f.importEntries()).status, 404); assert.deepEqual(f.snapshot(), before);
  assert.equal((await f.importEntries([f.entries[1].id, crypto.randomUUID()])).status, 404); assert.deepEqual(f.snapshot(), before);
});
test('import rejects project revoked after selection lookup without reference or audit', async t => {
  const f = await fixture(t), before = f.snapshot(), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), all = s.all; s.all = async () => { const rows = await all(); if (sql.includes('video_library_entries') && sql.includes('IN (')) f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.target); return rows; }; return s; };
  assert.equal((await f.importEntries()).status, 403); assert.deepEqual(f.snapshot(), before);
});
test('import logout after selection prevents any writes', async t => {
  const f = await fixture(t), before = f.snapshot(), prepare = f.db.prepare;
  f.db.prepare = sql => { const s = prepare(sql), all = s.all; s.all = async () => { const rows = await all(); if (sql.includes('video_library_entries')) f.logout(); return rows; }; return s; };
  assert.equal((await f.importEntries()).status, 403); assert.deepEqual(f.snapshot(), before);
});
test('memory-event failure rolls back all imported references and audit', async t => {
  const f = await fixture(t);
  f.seed('video_analyses', { video_id: f.entries[0].video, schema_version: 'analysis.v1', analysis_json: '{}', report_json: '{}', confidence: 90 });
  const before = f.snapshot(); f.sqlite.exec("CREATE TRIGGER synthetic_memory_failure BEFORE INSERT ON project_memory_events BEGIN SELECT RAISE(ABORT,'synthetic memory failure'); END");
  assert.equal((await f.importEntries()).status, 500); assert.deepEqual(f.snapshot(), before);
});
test('partial and unknown reports can be referenced without queuing automatic memory', async t => {
  const f = await fixture(t);
  f.seed('video_analyses', { video_id: f.entries[0].video, schema_version: 'analysis.v9', report_json: '{"summary":"保留部分分析"}' });
  f.seed('video_analyses', { video_id: f.entries[1].video, schema_version: 'analysis.future', report_json: '{}' });
  assert.equal((await f.importEntries()).status, 201);
  assert.equal(f.snapshot().project_video_references.length, 2);
  assert.equal(f.snapshot().project_memory_events.length, 0);
});
test('removal audit failure preserves the active reference', async t => {
  const f = await fixture(t); assert.equal((await f.importEntries([f.entries[0].id])).status, 201);
  const id = f.snapshot().project_video_references[0].id, before = f.snapshot(); f.sqlite.exec("CREATE TRIGGER synthetic_remove_failure BEFORE INSERT ON audit_logs WHEN NEW.action='video_library.removed' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.remove(id)).status, 500); assert.deepEqual(f.snapshot(), before);
});
test('metadata audit failure cannot leave a changed library entry', async t => {
  const f = await fixture(t), before = f.snapshot(); f.sqlite.exec("CREATE TRIGGER synthetic_edit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='video_library.updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await f.edit()).status, 500); assert.deepEqual(f.snapshot(), before);
});
test('metadata write denies company membership removed immediately before commit', async t => {
  const f = await fixture(t), before = f.snapshot();
  const injected = beforeCommit(f, () => f.sqlite.exec("UPDATE organization_members SET status='removed'"));
  const response = await f.edit(); injected(); assert.equal(response.status, 403); assert.deepEqual(f.snapshot(), before);
});

test('stale metadata form returns conflict without overwriting another member', async t => {
  const f = await fixture(t), old = f.snapshot().video_library_entries.find(row => row.id === f.entries[0].id).updated_at;
  assert.equal((await f.edit(old)).status, 200); const before = f.snapshot();
  assert.notEqual(before.video_library_entries.find(row => row.id === f.entries[0].id).updated_at, old);
  const response = await f.edit(old); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'LIBRARY_VERSION_CONFLICT'); assert.deepEqual(f.snapshot(), before);
});

test('source deletion between lookup and transaction rejects the entire import', async t => {
  const f = await fixture(t), before = f.snapshot();
  const injected = beforeCommit(f, () => f.sqlite.prepare('UPDATE videos SET deleted_at=? WHERE id=?').run(new Date().toISOString(), f.entries[0].video));
  const response = await f.importEntries(); injected(); assert.equal(response.status, 409); assert.deepEqual(f.snapshot(), before);
});

test('successful import, replay and reactivation preserve reference and memory identities', async t => {
  const f = await fixture(t), analysisId = f.seed('video_analyses', { video_id: f.entries[0].video, schema_version: 'analysis.v1', report_json: '{}' });
  const response = await f.importEntries(); assert.equal(response.status, 201); const body = await response.json(); assert.equal(body.imported, 2);
  assert.deepEqual([body.synchronized, body.created, body.reactivated, body.alreadyActive], [2, 2, 0, 0]);
  const first = f.snapshot(), reference = first.project_video_references.find(row => row.library_entry_id === f.entries[0].id);
  assert.equal(first.project_memory_events.length, 1);
  const event = first.project_memory_events[0], payload = JSON.parse(event.payload_json);
  assert.equal(event.project_id, f.target); assert.equal(event.created_by, f.owner.userId); assert.equal(payload.benchmarkReferenceId, reference.id); assert.equal(payload.analysisId, analysisId);
  const replay = await f.importEntries(); assert.equal(replay.status, 201); const replayBody = await replay.json();
  assert.deepEqual([replayBody.synchronized, replayBody.created, replayBody.reactivated, replayBody.alreadyActive], [2, 0, 0, 2]);
  assert.deepEqual(f.snapshot().project_memory_events, first.project_memory_events);
  assert.equal((await f.remove(reference.id)).status, 200); assert.equal(f.snapshot().project_video_references.find(row => row.id === reference.id).status, 'revoked');
  const reactivated = await f.importEntries([f.entries[0].id]); assert.equal(reactivated.status, 201); const reactivatedBody = await reactivated.json(); assert.equal(reactivatedBody.actions[0].action, 'reactivated');
  assert.deepEqual([reactivatedBody.synchronized, reactivatedBody.created, reactivatedBody.reactivated, reactivatedBody.alreadyActive], [1, 0, 1, 0]);
  const final = f.snapshot(); assert.equal(final.project_video_references.find(row => row.id === reference.id).status, 'active'); assert.deepEqual(final.project_memory_events, first.project_memory_events);
});

test('SQL guard rejects project access removed immediately before import transaction', async t => {
  const f = await fixture(t), before = f.snapshot();
  const injected = beforeCommit(f, () => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.target));
  const response = await f.importEntries(); injected(); assert.equal(response.status, 403); assert.deepEqual(f.snapshot(), before);
});

test('library metadata remains available to assigned employees and denies archived-only assignments', async t => {
  const f = await fixture(t); f.sqlite.exec("UPDATE organization_members SET role='member'");
  f.seed('project_members', { project_id: f.target, user_id: f.owner.userId, role: 'viewer', status: 'active' });
  assert.equal((await f.edit()).status, 200); const before = f.snapshot(); f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.target);
  assert.equal((await f.edit()).status, 403); assert.deepEqual(f.snapshot(), before);
});

test('library import rejects more than 100 selected entries without truncating', async t => {
  const f = await fixture(t), before = f.snapshot(); const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
  const response = await f.importEntries(ids); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'LIBRARY_IMPORT_LIMIT'); assert.deepEqual(f.snapshot(), before);
});

test('removal SQL guard protects permission change at transaction entry', async t => {
  const f = await fixture(t); assert.equal((await f.importEntries([f.entries[0].id])).status, 201);
  const before = f.snapshot(), id = before.project_video_references[0].id;
  const injected = beforeCommit(f, () => f.sqlite.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.target));
  const response = await f.remove(id); injected(); assert.equal(response.status, 403); assert.deepEqual(f.snapshot(), before);
});

test('metadata versions advance even when the persisted timestamp is ahead of the clock', async t => {
  const f = await fixture(t), old = '2099-10-12T01:00:00.000Z';
  f.sqlite.prepare('UPDATE video_library_entries SET updated_at=? WHERE id=?').run(old, f.entries[0].id);
  const first = await f.edit(old); assert.equal(first.status, 200);
  const version = (await first.json()).entry.updated_at; assert.equal(version, '2099-10-12T01:00:00.001Z');
  assert.equal((await f.edit(old)).status, 409);
  const second = await f.edit(version); assert.equal(second.status, 200); assert.equal((await second.json()).entry.updated_at, '2099-10-12T01:00:00.002Z');
});

test('competing reference created after selection keeps its identity and rejects stale import', async t => {
  const f = await fixture(t), id = crypto.randomUUID(); let before;
  const injected = beforeCommit(f, () => {
    f.seed('project_video_references', { id, project_id: f.target, library_entry_id: f.entries[0].id, purpose: 'benchmark', status: 'active' });
    before = f.snapshot();
  });
  const response = await f.importEntries(); injected(); assert.equal(response.status, 409); assert.deepEqual(f.snapshot(), before); assert.equal(f.snapshot().project_video_references[0].id, id);
});

test('analysis completed after selection requires refreshed import instead of missing its memory event', async t => {
  const f = await fixture(t), before = f.snapshot();
  const injected = beforeCommit(f, () => f.seed('video_analyses', { video_id: f.entries[0].video, schema_version: 'analysis.v1', report_json: '{}' }));
  const response = await f.importEntries(); injected(); assert.equal(response.status, 409); assert.deepEqual(f.snapshot(), before);
});

test('asset synchronization status follows the selected target project and preserves source records', async t => {
  const f = await fixture(t);
  f.runtime.canAccessOrganizationVideoLibrary = async () => true;
  const list = async projectId => {
    const query = new URLSearchParams({ organizationId: f.owner.organizationId, projectId });
    const response = await f.load('app/api/video-library/route.ts').GET(new Request('http://localhost/api/video-library?' + query));
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await list(f.target);
  assert.equal(before.entries.find(entry => entry.id === f.entries[0].id).imported_to_project, 0);
  assert.equal((await f.importEntries([f.entries[0].id])).status, 201);
  const target = await list(f.target), source = await list(f.source);
  assert.equal(target.entries.find(entry => entry.id === f.entries[0].id).imported_to_project, 1);
  assert.equal(source.entries.find(entry => entry.id === f.entries[0].id).imported_to_project, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM videos').get().n, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM video_library_entries').get().n, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_video_references WHERE status='active'").get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM analysis_model_calls').get().n, 0);
});
