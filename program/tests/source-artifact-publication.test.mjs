import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { installFixedLengthStream } from "./helpers/fixed-length-stream.mjs";

async function fixture(t, quota = 100) {
  installFixedLengthStream(t);
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  const owner = await f.initialize(); f.identity.userId = owner.userId;
  f.runtime.getProjectAccess = async () => ({ organizationRole: "admin", projectRole: "owner" });
  f.runtime.canWriteProjectAccess = () => true;
  f.sqlite.prepare("UPDATE organization_settings SET storage_quota_bytes=? WHERE organization_id=?").run(quota, owner.organizationId);
  const now = new Date().toISOString(), projectId = "source-project";
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(projectId, owner.organizationId, "Synthetic", "Synthetic", owner.userId, owner.userId, now, now);
  const objects = new Map(), deleted = [], uploaded = []; let afterPut = async () => {};
  const bucket = {
    async put(key, bytes, metadata) {
      let stored;
      if (bytes instanceof ReadableStream) {
        const reader = bytes.getReader(), hash = createHash("sha256"); let sizeBytes = 0, maximumChunk = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; sizeBytes += value.byteLength; maximumChunk = Math.max(maximumChunk, value.byteLength); hash.update(value); } }
        finally { reader.releaseLock(); }
        stored = { sizeBytes, maximumChunk, sha256: hash.digest("hex") };
      } else stored = new Uint8Array(bytes);
      objects.set(key, stored); uploaded.push({ key, metadata, streamed: bytes instanceof ReadableStream, stored }); await afterPut(key); return { key };
    },
    async delete(key) { deleted.push(key); objects.delete(key); },
  };
  f.runtime.getMediaBucket = () => bucket;
  function job(index = 1) {
    const videoId = `source-video-${index}`, jobId = `source-job-${index}`;
    f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(videoId, owner.organizationId, projectId, "douyin", "url", `https://example.invalid/${index}`, owner.userId, owner.userId, now, now);
    f.sqlite.prepare(`INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,lease_owner,lease_expires_at,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'analyzing','artifact-worker',?,?,?,?,?)`).run(jobId, owner.organizationId, projectId, videoId, "url", `https://example.invalid/${index}`, `source-test-${index}`, new Date(Date.now() + 60_000).toISOString(), owner.userId, owner.userId, now, now);
    return { videoId, jobId };
  }
  function asset(video, overrides = {}) {
    const row = { id: crypto.randomUUID(), kind: "source_video", filename: "existing.mp4", r2_key: "existing-object", content_type: "video/mp4", size_bytes: 2, sha256: "a".repeat(64), ...overrides };
    f.sqlite.prepare("INSERT INTO media_assets(id,organization_id,project_id,video_id,kind,r2_key,filename,content_type,size_bytes,sha256,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)")
      .run(row.id, owner.organizationId, projectId, video.videoId, row.kind, row.r2_key, row.filename, row.content_type, row.size_bytes, row.sha256, owner.userId, owner.userId, now, now);
    return row;
  }
  const upload = (job, changes = {}, bytes = [1, 2, 3, 4]) => f.load("app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts").POST(new Request("http://localhost/artifacts", {
    method: "POST", headers: { authorization: "Bearer synthetic-service-token", "x-worker-id": "artifact-worker", "x-job-version": "0", "x-artifact-kind": "source_video", "x-artifact-filename": "original.mp4", "content-type": "video/mp4", "content-length": String(bytes.byteLength ?? bytes.length), ...changes }, body: new Uint8Array(bytes),
  }), { params: Promise.resolve({ jobId: job.jobId }) });
  return { ...f, owner, projectId, objects, deleted, uploaded, job, asset, upload, onPut: callback => { afterPut = callback; } };
}

test("source publication binds a null primary reference, is idempotent, and supports audio with strict media types", async t => {
  const f = await fixture(t), video = f.job();
  const first = await f.upload(video); assert.equal(first.status, 201, await first.clone().text());
  const body = await first.json(), saved = f.sqlite.prepare("SELECT * FROM media_assets").get();
  assert.equal(saved.id, body.asset.id); assert.equal(saved.analysis_job_id, video.jobId);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, saved.id);
  assert.equal(f.uploaded[0].metadata.customMetadata.organizationId, f.owner.organizationId);
  assert.equal(f.uploaded[0].metadata.httpMetadata.contentType, "video/mp4");
  const replay = await f.upload(video); assert.equal(replay.status, 200); assert.equal((await replay.json()).reused, true); assert.equal(f.uploaded.length, 2);
  assert.equal((await f.upload(video, { "content-length": String(1024 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.upload(video, { "content-type": "text/html" })).status, 415);
  assert.equal(f.uploaded.length, 2); assert.equal(f.objects.size, 1);
  const audio = f.job(2), result = await f.upload(audio, { "x-artifact-kind": "source_audio", "x-artifact-filename": "original.m4a", "content-type": "audio/mp4" });
  assert.equal(result.status, 201); assert.equal((await result.json()).asset.kind, "source_audio");
});

test("a new analysis source never overwrites an existing upload or earlier source reference", async t => {
  const f = await fixture(t), video = f.job(), previous = f.asset(video);
  f.objects.set(previous.r2_key, new Uint8Array([9, 9]));
  f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(previous.id, video.videoId);
  const before = f.sqlite.prepare("SELECT * FROM media_assets WHERE id=?").get(previous.id);
  assert.equal((await f.upload(video)).status, 201);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, previous.id);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM media_assets WHERE id=?").get(previous.id), before);
  assert.equal(f.objects.size, 2); assert.deepEqual(f.deleted, []);
});

test("concurrent source uploads cannot exceed company storage and clean only the losing object", async t => {
  const f = await fixture(t, 10), a = f.job(1), b = f.job(2);
  let count = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.onPut(async () => { if (++count === 2) release(); await barrier; });
  const results = await Promise.all([f.upload(a, {}, [1, 2, 3, 4, 5, 6]), f.upload(b, {}, [6, 5, 4, 3, 2, 1])]);
  assert.deepEqual(results.map(row => row.status).sort(), [201, 413]);
  const failure = results.find(row => row.status === 413); assert.equal((await failure.json()).error.code, "SOURCE_STORAGE_QUOTA_EXCEEDED");
  const assets = f.sqlite.prepare("SELECT id,r2_key,size_bytes,video_id FROM media_assets WHERE status='active'").all();
  assert.equal(assets.length, 1); assert.equal(assets[0].size_bytes, 6);
  assert.equal(f.objects.size, 1); assert.equal(f.deleted.length, 1);
  assert.ok(f.objects.has(assets[0].r2_key)); assert.ok(!f.deleted.includes(assets[0].r2_key));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM videos WHERE media_asset_id IS NOT NULL").get().n, 1);
});

test("quota rejection before publication does not create any object or primary reference", async t => {
  const f = await fixture(t, 3), video = f.job();
  const response = await f.upload(video); assert.equal(response.status, 413);
  assert.equal(f.uploaded.length, 0); assert.equal(f.objects.size, 0); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, null);
});

test("real cancellation after R2 publication leaves neither a source row nor an orphan object", async t => {
  const f = await fixture(t), video = f.job();
  f.onPut(async () => {
    const response = await f.load("app/api/analysis-jobs/[jobId]/cancel/route.ts").POST(new Request("http://localhost/cancel", { method: "POST" }), { params: Promise.resolve({ jobId: video.jobId }) });
    assert.equal(response.status, 200, await response.clone().text());
  });
  const response = await f.upload(video); assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, "ARTIFACT_LEASE_INVALID");
  assert.equal(f.objects.size, 0); assert.equal(f.deleted.length, 1); assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 0);
  const job = f.sqlite.prepare("SELECT status,version FROM analysis_jobs WHERE id=?").get(video.jobId); assert.equal(job.status, "cancelled"); assert.equal(job.version, 1);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, null);
});

test("lost transaction acknowledgement preserves the committed source and primary reference", async t => {
  const f = await fixture(t), video = f.job(), batch = f.db.batch;
  f.db.batch = async statements => { await batch(statements); throw new Error("Synthetic lost acknowledgement"); };
  const response = await f.upload(video); assert.equal(response.status, 201);
  const saved = f.sqlite.prepare("SELECT id,r2_key FROM media_assets").get();
  assert.equal(f.objects.size, 1); assert.ok(f.objects.has(saved.r2_key)); assert.deepEqual(f.deleted, []);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, saved.id);
});

test("simultaneous publication retries of the same source retain one asset and one object", async t => {
  const f = await fixture(t), video = f.job();
  let count = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.onPut(async () => { if (++count === 2) release(); await barrier; });
  const responses = await Promise.all([f.upload(video), f.upload(video)]);
  assert.ok(responses.every(row => [200, 201].includes(row.status)));
  const bodies = await Promise.all(responses.map(row => row.json()));
  assert.equal(bodies[0].asset.id, bodies[1].asset.id);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE status='active'").get().n, 1);
  assert.equal(f.objects.size, 1);
});

test("only manuscript JSON receives the extended subtitle allowance, for both declared and actual bytes", async t => {
  const f = await fixture(t, 64 * 1024 * 1024), video = f.job();
  const headers = { "x-artifact-kind": "subtitle", "x-artifact-filename": "manuscript.json", "content-type": "application/json" };
  const body = new TextEncoder().encode(JSON.stringify({ version: "manuscript.v1", segments: [{ text: "语".repeat(710_000) }] }));
  assert.ok(body.byteLength > 2 * 1024 * 1024);
  const accepted = await f.upload(video, headers, body);
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await f.upload(video, { ...headers, "x-artifact-filename": "other.json" }, body)).status, 413);
  assert.equal((await f.upload(video, { ...headers, "content-type": "text/vtt" }, body)).status, 413);
  const overflow = 16 * 1024 * 1024 + 1;
  assert.equal((await f.upload(video, { ...headers, "content-length": String(overflow) })).status, 413);
  assert.equal((await f.upload(video, headers, new Uint8Array(overflow))).status, 413);
  assert.equal(f.uploaded.length, 1);
});

function streamUpload(f, video, length, body, extraHeaders = {}, signal) {
  const request = new Request("http://localhost/artifacts", { method: "POST", duplex: "half", body, signal,
    headers: { authorization: "Bearer synthetic-service-token", "x-worker-id": "artifact-worker", "x-job-version": "0", "x-artifact-kind": "source_video", "x-artifact-filename": "original.mp4", "content-type": "video/mp4",
      ...(length === null ? {} : { "content-length": String(length) }), ...extraHeaders } });
  request.arrayBuffer = () => { throw new Error("Whole-source buffering is forbidden"); };
  return f.load("app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts").POST(request, { params: Promise.resolve({ jobId: video.jobId }) });
}

test("source API requires length, rejects over 1 GiB early and removes incomplete streamed objects", async t => {
  const f = await fixture(t, 2 * 1024 ** 3), video = f.job();
  const missing = await streamUpload(f, video, null, new Uint8Array([1]));
  assert.equal(missing.status, 411); assert.equal((await missing.json()).error.code, "ARTIFACT_LENGTH_REQUIRED");
  const overflow = await streamUpload(f, video, 1024 ** 3 + 1, new Uint8Array([1]));
  assert.equal(overflow.status, 413); assert.equal((await overflow.json()).error.code, "ARTIFACT_TOO_LARGE");
  assert.equal(f.deleted.length, 0);
  for (const length of [1, 5, 1024 ** 3]) {
    const incomplete = await streamUpload(f, video, length, new Uint8Array([1, 2, 3]));
    assert.equal(incomplete.status, 413); assert.equal((await incomplete.json()).error.code, "INVALID_ARTIFACT_SIZE");
  }
  assert.equal(f.objects.size, 0); assert.equal(f.deleted.length, 3);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, null);
});

test("source video and audio above 100 MiB stream to storage with exact D1 hashes", async t => {
  const f = await fixture(t, 512 * 1024 * 1024), size = 101 * 1024 * 1024 + 17;
  for (const [index, kind, contentType] of [[1, "source_video", "video/mp4"], [2, "source_audio", "audio/mp4"]]) {
    const video = f.job(index), chunk = new Uint8Array(64 * 1024).fill(index); let remaining = size;
    const body = new ReadableStream({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const count = Math.min(remaining, chunk.length); remaining -= count; controller.enqueue(chunk.subarray(0, count));
    } }, { highWaterMark: 0 });
    const response = await streamUpload(f, video, size, body, { "x-artifact-kind": kind, "content-type": contentType });
    assert.equal(response.status, 201, await response.clone().text()); const data = await response.json();
    const source = f.sqlite.prepare("SELECT size_bytes,sha256,r2_key FROM media_assets WHERE id=?").get(data.asset.id);
    const stored = f.objects.get(source.r2_key);
    assert.equal(source.size_bytes, size); assert.equal(stored.sizeBytes, size); assert.equal(source.sha256, stored.sha256);
    assert.equal(data.asset.sha256, source.sha256); assert.ok(stored.maximumChunk <= 64 * 1024);
    const receipt = f.uploaded.find(item => item.key === source.r2_key);
    assert.equal(receipt.streamed, true); assert.equal(receipt.metadata.customMetadata.sha256, undefined);
  }
});

test("full-quota exact replays reuse the source while same-size changed bytes cannot publish", async t => {
  const f = await fixture(t, 4), video = f.job();
  const first = await f.upload(video); assert.equal(first.status, 201); const original = await first.json();
  const replay = await f.upload(video); assert.equal(replay.status, 200); assert.equal((await replay.json()).asset.id, original.asset.id);
  const different = await f.upload(video, {}, [4, 3, 2, 1]); assert.equal(different.status, 413);
  assert.equal(f.uploaded.length, 1); assert.equal(f.objects.size, 1); assert.deepEqual(f.deleted, []);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 1);
});

test("streamed source publication tolerates heartbeat revisions but rejects a replacement attempt", async t => {
  const f = await fixture(t), first = f.job();
  f.sqlite.prepare("UPDATE analysis_jobs SET attempt_count=1 WHERE id=?").run(first.jobId);
  f.onPut(async () => { f.sqlite.prepare("UPDATE analysis_jobs SET version=version+1 WHERE id=?").run(first.jobId); });
  assert.equal((await f.upload(first, { "x-worker-attempt": "1" })).status, 201);
  const replacement = f.job(2); f.sqlite.prepare("UPDATE analysis_jobs SET attempt_count=1 WHERE id=?").run(replacement.jobId);
  f.onPut(async () => { f.sqlite.prepare("UPDATE analysis_jobs SET attempt_count=2,version=version+1 WHERE id=?").run(replacement.jobId); });
  const rejected = await f.upload(replacement, { "x-worker-attempt": "1" });
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, "ARTIFACT_LEASE_INVALID");
  assert.equal(f.objects.size, 1); assert.equal(f.deleted.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets").get().n, 1);
});

for (const bigChunk of [false, true]) test(`request abort removes only its partial source object (${bigChunk ? "large chunk" : "stalled body"})`, { timeout: 2000 }, async t => {
  const f = await fixture(t, 16 * 1024 * 1024), video = f.job(), prior = f.asset(video), abort = new AbortController();
  f.objects.set(prior.r2_key, new Uint8Array([9, 9]));
  f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(prior.id, video.videoId);
  const bucket = f.runtime.getMediaBucket(); let targetKey, startPut, cancelled = false, emitted = false, putRejected = false;
  const started = new Promise(resolve => { startPut = resolve; });
  f.runtime.getMediaBucket = () => ({ ...bucket, async put(key, stream) {
    targetKey = key; f.objects.set(key, { partial: true }); const reader = stream.getReader();
    if (!bigChunk) startPut();
    try { while (true) {
      const { done } = await reader.read(); if (done) break;
      startPut(); await new Promise(resolve => setTimeout(resolve, 20));
    } } catch (error) { putRejected = true; throw error; }
    finally { reader.releaseLock(); }
    return { key };
  } });
  const chunk = new Uint8Array(4 * 1024 * 1024), body = new ReadableStream({
    pull(controller) { if (bigChunk && !emitted) { emitted = true; controller.enqueue(chunk); } },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const responsePromise = streamUpload(f, video, bigChunk ? chunk.length + 1 : 8, body, {}, abort.signal);
  await started; abort.abort(new DOMException("Synthetic HTTP disconnect", "AbortError"));
  const response = await responsePromise; assert.ok(response.status >= 400); assert.equal(cancelled, true); assert.equal(putRejected, true);
  assert.deepEqual(f.deleted, [targetKey]); assert.notEqual(targetKey, prior.r2_key); assert.equal(f.objects.size, 1); assert.ok(f.objects.has(prior.r2_key));
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM media_assets").all().map(row => row.id), [prior.id]);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, prior.id);
});

test("disconnect after source EOF before R2 ACK removes only its unpublished object", { timeout: 2000 }, async t => {
  const f = await fixture(t), video = f.job(), prior = f.asset(video), abort = new AbortController();
  f.objects.set(prior.r2_key, new Uint8Array([9, 9]));
  f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(prior.id, video.videoId);
  let targetKey, sourceDrained, acknowledgePut;
  const drained = new Promise(resolve => { sourceDrained = resolve; });
  const acknowledgement = new Promise(resolve => { acknowledgePut = resolve; });
  f.onPut(async key => { targetKey = key; sourceDrained(); await acknowledgement; });
  const pending = streamUpload(f, video, 4, new Uint8Array([1, 2, 3, 4]), {}, abort.signal);
  await drained;
  assert.equal(f.objects.get(targetKey).sizeBytes, 4);
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM media_assets").all().map(row => row.id), [prior.id]);
  abort.abort(new DOMException("Synthetic disconnect before R2 ACK", "AbortError")); acknowledgePut();
  const response = await pending; assert.ok(response.status >= 400);
  assert.deepEqual(f.deleted, [targetKey]); assert.notEqual(targetKey, prior.r2_key);
  assert.equal(f.objects.size, 1); assert.ok(f.objects.has(prior.r2_key));
  assert.deepEqual(f.sqlite.prepare("SELECT id FROM media_assets").all().map(row => row.id), [prior.id]);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, prior.id);
});

test("disconnect after a committed source and lost ACK preserves the saved bytes and primary reference", async t => {
  const f = await fixture(t), video = f.job(), abort = new AbortController(), batch = f.db.batch;
  f.db.batch = async statements => {
    await batch(statements); abort.abort(new DOMException("Synthetic lost ACK", "AbortError"));
    throw new Error("Synthetic committed response lost");
  };
  const response = await streamUpload(f, video, 4, new Uint8Array([1, 2, 3, 4]), {}, abort.signal);
  assert.equal(response.status, 201); const data = await response.json(), saved = f.sqlite.prepare("SELECT id,r2_key FROM media_assets").get();
  assert.equal(data.asset.id, saved.id); assert.ok(f.objects.has(saved.r2_key)); assert.deepEqual(f.deleted, []);
  assert.equal(f.sqlite.prepare("SELECT media_asset_id FROM videos WHERE id=?").get(video.videoId).media_asset_id, saved.id);
});
