import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeFixture } from './helpers/runtime-fixture.mjs';

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize();
  f.identity.userId = owner.userId;
  f.runtime.getProjectAccess = async () => ({ allowed: true });
  f.runtime.canWriteProjectAccess = access => access.allowed;
  f.runtime.hashInvitationToken = value => f.runtime.sha256Hex(new TextEncoder().encode(value));
  const stamp = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES('synthetic-project',?,'Synthetic','Synthetic',?,?,?,?)").run(owner.organizationId, owner.userId, owner.userId, stamp, stamp);
  let preflight = 0, writes = 0;
  f.mock('lib/analysis-submission-availability.ts', { checkNewAnalysisAvailability: async () => { preflight++; return Response.json({}, { status: 503 }); } });
  f.runtime.getMediaBucket = () => ({ put: async () => { writes++; return {}; }, delete: async () => {} });
  const headers = { 'x-organization-id': owner.organizationId, 'x-project-id': 'synthetic-project' };
  const upload = request => f.load('app/api/videos/upload/route.ts').POST(request);
  const url = request => f.load('app/api/videos/from-url/route.ts').POST(request);
  return { ...f, upload, url, headers, effects: () => ({ preflight, writes, assets: f.sqlite.prepare('SELECT COUNT(*) n FROM media_assets').get().n, videos: f.sqlite.prepare('SELECT COUNT(*) n FROM videos').get().n }) };
}

test('declared oversized upload is rejected without asking the multipart parser to consume it', async t => {
  const f = await fixture(t), body = new FormData(); body.set('file', new File(['synthetic'], 'small.mp4', { type: 'video/mp4' }));
  // Server requests receive already encoded multipart bytes, not Undici's
  // outgoing FormData generator (which rejects asynchronously on early cancel).
  const encoded = new Request('http://localhost/upload', { method: 'POST', body });
  const request = new Request('http://localhost/upload', { method: 'POST', headers: { ...f.headers, 'content-type': encoded.headers.get('content-type'), 'content-length': String(60 * 1024 * 1024) }, body: await encoded.arrayBuffer() });
  let parsed = 0; const parse = request.formData.bind(request); request.formData = async () => { parsed++; return parse(); };
  const response = await f.upload(request); assert.equal(response.status, 413); assert.equal(parsed, 0);
  assert.deepEqual(f.effects(), { preflight: 0, writes: 0, assets: 0, videos: 0 });
});
for (const [name, type, body] of [['missing boundary', 'multipart/form-data', 'x'], ['truncated multipart', 'multipart/form-data; boundary=synthetic', '--synthetic\r\nContent-Disposition: form-data; name="file"\r\n\r\nx']]) {
  test(`malformed upload returns a useful 400: ${name}`, async t => {
    const f = await fixture(t), response = await f.upload(new Request('http://localhost/upload', { method: 'POST', headers: { ...f.headers, 'content-type': type }, body }));
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_MULTIPART');
    assert.deepEqual(f.effects(), { preflight: 0, writes: 0, assets: 0, videos: 0 });
  });
}
test('exactly 50 MiB file remains valid with multipart overhead; one byte more is rejected', async t => {
  const f = await fixture(t), maximum = 50 * 1024 * 1024;
  for (const bytes of [maximum, maximum + 1]) {
    const body = new FormData(); body.set('file', new File([new Uint8Array(bytes)], 'boundary.mp4', { type: 'video/mp4' })); body.set('analysisProfile', 'standard');
    const response = await f.upload(new Request('http://localhost/upload', { method: 'POST', headers: f.headers, body }));
    assert.equal(response.status, bytes === maximum ? 503 : 413);
    if (bytes > maximum) assert.equal((await response.json()).error.code, 'INVALID_FILE_SIZE');
  }
  assert.deepEqual(f.effects(), { preflight: 1, writes: 0, assets: 0, videos: 0 });
});
test('bounded multipart stream cancels after its byte limit and ignores a smaller declared length', async t => {
  const f = await fixture(t), { readBoundedFormData } = f.load('lib/bounded-request-body.ts');
  let sent = 0, cancelled = false;
  const body = new ReadableStream({ pull(c) { sent++; c.enqueue(new Uint8Array(16 * 1024).fill(120)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request('http://localhost/upload', { method: 'POST', duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'content-length': '1' }, body });
  await assert.rejects(readBoundedFormData(request, 64, 'synthetic limit'), e => e.code === 'REQUEST_BODY_TOO_LARGE' && e.status === 413);
  assert.ok(sent <= 5); assert.equal(cancelled, true); assert.equal(request.body.locked, false);
});
test('malformed multipart metadata cancels and releases the untouched incoming stream', async t => {
  const f = await fixture(t), { readBoundedFormData } = f.load('lib/bounded-request-body.ts');
  t.mock.method(Response.prototype, 'formData', async () => { throw new TypeError('synthetic metadata rejected before body consumption'); });
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request('http://localhost/upload', { method: 'POST', duplex: 'half', headers: { 'content-type': 'multipart/form-data' }, body });
  await assert.rejects(readBoundedFormData(request, 64, 'synthetic limit'), e => e.code === 'INVALID_MULTIPART');
  assert.equal(cancelled, true); assert.equal(request.body.locked, false);
});
test('oversized declared link request is rejected before JSON consumption', async t => {
  const f = await fixture(t), request = new Request('http://localhost/url', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1048576' }, body: '{}' });
  let parsed = 0; const parse = request.json.bind(request); request.json = async () => { parsed++; return parse(); };
  const response = await f.url(request); assert.equal(response.status, 413); assert.equal(parsed, 0);
});
test('chunked link input is bounded even with a forged small content-length', async t => {
  const f = await fixture(t); let sent = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { sent++; if (sent <= 200) controller.enqueue(new Uint8Array(1024).fill(32)); else controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const response = await f.url(new Request('http://localhost/url', { method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: stream }));
  assert.equal(response.status, 413); assert.ok(sent <= 97); assert.equal(cancelled, true);
});
for (const body of ['{', 'null', '[]', '{"organizationId":23,"projectId":"p","url":"https://www.douyin.com/video/1234567890123456789"}']) {
  test(`invalid link input is a 400, not a server error: ${body}`, async t => {
    const f = await fixture(t), response = await f.url(new Request('http://localhost/url', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    assert.equal(response.status, 400); assert.deepEqual(f.effects(), { preflight: 0, writes: 0, assets: 0, videos: 0 });
  });
}
test('link limit counts UTF-8 bytes and accepts exactly 32 KiB', async t => {
  const f = await fixture(t), limit = 32 * 1024;
  const input = { organizationId: f.headers['x-organization-id'], projectId: 'synthetic-project', url: 'https://www.douyin.com/video/1234567890123456789', title: '' };
  const available = limit - Buffer.byteLength(JSON.stringify(input));
  input.title = '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  const encoded = JSON.stringify(input); assert.equal(Buffer.byteLength(encoded), limit);
  assert.equal((await f.url(new Request('http://localhost/url', { method: 'POST', body: encoded }))).status, 503);
  assert.equal((await f.url(new Request('http://localhost/url', { method: 'POST', body: encoded + ' ' }))).status, 413);
  assert.equal(f.effects().preflight, 1);
});
for (const endpoint of ['upload', 'url']) {
  test(`${endpoint} rejects anonymous requests before reading their body`, async t => {
    const f = await fixture(t); f.mock('lib/request-auth.ts', { readRequestIdentity: async () => null });
    let reads = 0; const body = new ReadableStream({ pull(c) { reads++; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    const response = await f[endpoint](new Request(`http://localhost/${endpoint}`, { method: 'POST', duplex: 'half', headers: f.headers, body }));
    assert.equal(response.status, 401); assert.equal(reads, 0); assert.equal(f.effects().preflight, 0);
  });
}
test('missing link body is a readable 400 without business side effects', async t => {
  const f = await fixture(t), response = await f.url(new Request('http://localhost/url', { method: 'POST' }));
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'REQUEST_BODY_REQUIRED');
  assert.deepEqual(f.effects(), { preflight: 0, writes: 0, assets: 0, videos: 0 });
});
test('oversize header rejection discards only a bounded prefix even when the declared length lies', async t => {
  const f = await fixture(t), { readBoundedJson } = f.load('lib/bounded-request-body.ts');
  let chunks = 0, cancelled = false;
  const body = new ReadableStream({ pull(c) { chunks++; c.enqueue(new Uint8Array(16 * 1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request('http://localhost/url', { method: 'POST', duplex: 'half', headers: { 'content-length': '2000' }, body });
  await assert.rejects(readBoundedJson(request, 64, 'synthetic size rejection'), e => e.status === 413);
  assert.ok(chunks <= 5); assert.equal(cancelled, true); assert.equal(request.body.locked, false);
});
test('a declared oversize request that stops sending is cancelled after the grace deadline', async t => {
  const f = await fixture(t), { readBoundedJson } = f.load('lib/bounded-request-body.ts');
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request('http://localhost/url', { method: 'POST', duplex: 'half', headers: { 'content-length': '2000' }, body });
  await assert.rejects(readBoundedJson(request, 64, 'synthetic size rejection'), e => e.status === 413);
  assert.equal(cancelled, true); assert.equal(request.body.locked, false);
});
