import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { installFixedLengthStream } from "./helpers/fixed-length-stream.mjs";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

function request(length, chunks, onCancel = () => {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel: onCancel,
  }, { highWaterMark: 0 });
  const result = new Request("http://localhost/source", { method: "POST", headers: length === null ? {} : { "content-length": String(length) }, body, duplex: "half" });
  result.arrayBuffer = () => { throw new Error("Whole-source buffering is forbidden"); };
  return result;
}

function fixture(t) {
  installFixedLengthStream(t);
  return runtimeFixture(t).load("lib/source-artifact-body.ts");
}

test("source lengths accept exactly 1 GiB, reject larger or invalid declarations, and require a length", t => {
  const { sourceArtifactLength, SOURCE_ARTIFACT_MAX_BYTES } = fixture(t);
  assert.equal(SOURCE_ARTIFACT_MAX_BYTES, 1024 ** 3);
  assert.equal(sourceArtifactLength(request(1024 ** 3, [new Uint8Array([1])])), 1024 ** 3);
  for (const [length, status] of [[null, 411], [1024 ** 3 + 1, 413], ["NaN", 400], ["-1", 400], ["2.5", 400], [0, 413]]) {
    assert.throws(() => sourceArtifactLength(request(length, [])), error => error.status === status, String(length));
  }
});

test("source storage receives a stream, keeps exact byte count and hashes incrementally", async t => {
  const { storeSourceArtifactBody } = fixture(t);
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])];
  const received = [];
  const bucket = { async put(_key, stream) {
    assert.ok(stream instanceof ReadableStream);
    const reader = stream.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; received.push([...value]); } }
    finally { reader.releaseLock(); }
    return { key: "synthetic" };
  } };
  const result = await storeSourceArtifactBody(request(6, chunks), 6, bucket, "synthetic", {}, 8);
  assert.equal(result.sizeBytes, 6); assert.equal(result.sha256, createHash("sha256").update(new Uint8Array([1, 2, 3, 4, 5, 6])).digest("hex"));
  assert.deepEqual(received, chunks.map(chunk => [...chunk]));
});

for (const [name, length, maximum, chunks] of [
  ["underflow", 5, 8, [new Uint8Array([1, 2])]],
  ["declared-length overflow", 2, 8, [new Uint8Array([1, 2, 3])]],
  ["maximum overflow", 6, 4, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]],
]) test(`stream ${name} fails without reporting a complete source`, async t => {
  const { storeSourceArtifactBody } = fixture(t);
  const bucket = { async put(_key, stream) {
    const reader = stream.getReader(); try { while (!(await reader.read()).done) { /* Consume until the synthetic body fails. */ } } finally { reader.releaseLock(); }
    return { key: "synthetic" };
  } };
  await assert.rejects(storeSourceArtifactBody(request(length, chunks), length, bucket, "synthetic", {}, maximum), error => error.code === "INVALID_ARTIFACT_SIZE" && error.status === 413);
});

test("an early R2 failure cancels the incoming source instead of leaving a blocked pump", { timeout: 2000 }, async t => {
  const { storeSourceArtifactBody } = fixture(t); let cancelled = false;
  const source = request(8, [new Uint8Array([1, 2]), new Uint8Array([3, 4])], () => { cancelled = true; });
  await assert.rejects(storeSourceArtifactBody(source, 8, { put: async () => { throw new Error("synthetic storage unavailable"); } }, "synthetic", {}), /synthetic storage unavailable/);
  assert.equal(cancelled, true);
});

test("a full-quota replay can be hashed without storing or buffering it", async t => {
  const { hashSourceArtifactBody } = fixture(t);
  const result = await hashSourceArtifactBody(request(4, [new Uint8Array([9, 8]), new Uint8Array([7, 6])]), 4);
  assert.equal(result.sizeBytes, 4);
  assert.equal(result.sha256, createHash("sha256").update(new Uint8Array([9, 8, 7, 6])).digest("hex"));
});

test("request abort interrupts a slow incoming body and rejects the pending R2 put", { timeout: 2000 }, async t => {
  const { storeSourceArtifactBody } = fixture(t), abort = new AbortController();
  let cancelled = false, putRejected = false, startPut;
  const started = new Promise(resolve => { startPut = resolve; });
  const body = new ReadableStream({ pull() { /* No EOF arrives from this stalled transport. */ }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const source = new Request("http://localhost/source", { method: "POST", headers: { "content-length": "8" }, body, duplex: "half", signal: abort.signal });
  const operation = storeSourceArtifactBody(source, 8, { async put(_key, stream) {
    const reader = stream.getReader(); startPut();
    try { while (!(await reader.read()).done) { /* Wait for the blocked source. */ } }
    catch (error) { putRejected = true; throw error; }
    finally { reader.releaseLock(); }
    return { key: "synthetic" };
  } }, "synthetic", {});
  const rejected = assert.rejects(operation); await started;
  abort.abort(new DOMException("Synthetic request disconnected", "AbortError"));
  await rejected; assert.equal(cancelled, true); assert.equal(putRejected, true);
});

test("aborting a large upstream chunk stops forwarding and releases the unread transport", { timeout: 2000 }, async t => {
  const { storeSourceArtifactBody } = fixture(t), abort = new AbortController(), chunk = new Uint8Array(4 * 1024 * 1024).fill(3);
  let cancelled = false, sent = false, receivedBytes = 0, maximumChunk = 0, firstRead;
  const read = new Promise(resolve => { firstRead = resolve; });
  const body = new ReadableStream({
    pull(controller) { if (!sent) { sent = true; controller.enqueue(chunk); } },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const length = chunk.length + 1, source = new Request("http://localhost/source", { method: "POST", headers: { "content-length": String(length) }, body, duplex: "half", signal: abort.signal });
  const operation = storeSourceArtifactBody(source, length, { async put(_key, stream) {
    const reader = stream.getReader();
    try { while (true) {
      const { done, value } = await reader.read(); if (done) break;
      receivedBytes += value.length; maximumChunk = Math.max(maximumChunk, value.length); firstRead();
      await new Promise(resolve => setTimeout(resolve, 20));
    } } finally { reader.releaseLock(); }
    return { key: "synthetic" };
  } }, "synthetic", {});
  const rejected = assert.rejects(operation); await read;
  abort.abort(new DOMException("Synthetic request disconnected", "AbortError"));
  await rejected; assert.equal(cancelled, true); assert.ok(receivedBytes < chunk.length); assert.ok(maximumChunk <= 64 * 1024);
});

test("full-quota hash-only verification also stops on request abort", { timeout: 2000 }, async t => {
  const { hashSourceArtifactBody } = fixture(t), abort = new AbortController(); let cancelled = false, startRead;
  const started = new Promise(resolve => { startRead = resolve; });
  const body = new ReadableStream({ pull() { startRead(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const source = new Request("http://localhost/source", { method: "POST", headers: { "content-length": "8" }, body, duplex: "half", signal: abort.signal });
  const rejected = assert.rejects(hashSourceArtifactBody(source, 8)); await started;
  abort.abort(new DOMException("Synthetic replay disconnected", "AbortError"));
  await rejected; assert.equal(cancelled, true);
});

test("request abort after source EOF but before R2 acknowledgement cannot return a saved receipt", { timeout: 2000 }, async t => {
  const { storeSourceArtifactBody } = fixture(t), abort = new AbortController();
  let sourceDrained, acknowledgePut;
  const drained = new Promise(resolve => { sourceDrained = resolve; });
  const acknowledgement = new Promise(resolve => { acknowledgePut = resolve; });
  const source = new Request("http://localhost/source", { method: "POST", headers: { "content-length": "4" }, body: new Uint8Array([1, 2, 3, 4]), signal: abort.signal });
  const operation = storeSourceArtifactBody(source, 4, { async put(_key, stream) {
    const reader = stream.getReader(); let sizeBytes = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; sizeBytes += value.byteLength; } }
    finally { reader.releaseLock(); }
    assert.equal(sizeBytes, 4); sourceDrained(); await acknowledgement;
    return { key: "synthetic" };
  } }, "synthetic", {});
  const rejected = assert.rejects(operation); await drained;
  abort.abort(new DOMException("Synthetic disconnect before R2 ACK", "AbortError")); acknowledgePut();
  await rejected;
});
