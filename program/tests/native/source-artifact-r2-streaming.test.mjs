// Run explicitly with native subprocess/loopback access:
// node --test tests/native/source-artifact-r2-streaming.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import ts from "typescript";

const helper = ts.transpileModule(readFileSync(new URL("../../lib/source-artifact-body.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^export /gm, "");
const worker = helper + `
let activeSourceTransfers = 0;
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/control') {
    await env.DB.prepare('SELECT sequence FROM synthetic_control WHERE id=1').first();
    return Response.json({ inProgress: activeSourceTransfers > 0 });
  }
  if (url.pathname === '/heartbeat') {
    await env.DB.prepare('UPDATE synthetic_control SET sequence=sequence+1 WHERE id=1').run();
    return Response.json({ inProgress: activeSourceTransfers > 0 });
  }
  if (url.pathname === '/upload-http') {
    const length = sourceArtifactLength(request);
    activeSourceTransfers++;
    let receipt;
    try {
      receipt = await storeSourceArtifactBody(request, length, env.MEDIA, 'synthetic-http-source', { httpMetadata: { contentType: 'video/mp4' } });
    } finally { activeSourceTransfers--; }
    const stored = await env.MEDIA.head('synthetic-http-source');
    await env.MEDIA.delete('synthetic-http-source');
    return Response.json({ receipt, storedSize: stored.size });
  }
  const length = Number(url.searchParams.get('length'));
  const chunk = new Uint8Array(64 * 1024).fill(7); let remaining = length;
  const incoming = new Request('https://synthetic.invalid/source', { method: 'POST', headers: { 'content-length': String(length) },
    body: new ReadableStream({ pull(controller) { const size = Math.min(chunk.length, remaining); if (!size) { controller.close(); return; } controller.enqueue(chunk.subarray(0, size)); remaining -= size; } }, { highWaterMark: 0 }) });
  incoming.arrayBuffer = () => { throw new Error('Whole-source buffering is forbidden'); };
  const receipt = await storeSourceArtifactBody(incoming, sourceArtifactLength(incoming), env.MEDIA, 'synthetic-source', { httpMetadata: { contentType: 'video/mp4' } });
  const stored = await env.MEDIA.get('synthetic-source');
  const hash = createHash('sha256'); let readSize = 0, maximumChunk = 0;
  const reader = stored.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; readSize += value.length; maximumChunk = Math.max(maximumChunk, value.length); hash.update(value); } } finally { reader.releaseLock(); }
  await env.MEDIA.delete('synthetic-source');
  return Response.json({ receipt, storedSize: stored.size, readSize, maximumChunk, sha256: hash.digest('hex'), contentType: stored.httpMetadata.contentType });
} };
`;

test("native workerd FixedLengthStream writes and reads actual R2 for small and above-old-limit sources", { timeout: 60000 }, async t => {
  const mf = new Miniflare({ modules: true, script: worker, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], r2Buckets: ["MEDIA"] });
  t.after(() => mf.dispose());
  for (const length of [9, 101 * 1024 * 1024 + 17]) {
    const response = await mf.dispatchFetch(`https://synthetic.invalid/?length=${length}`);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json(), hash = createHash("sha256"), chunk = new Uint8Array(64 * 1024).fill(7);
    for (let remaining = length; remaining > 0; remaining -= chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, remaining)));
    const expected = hash.digest("hex");
    assert.equal(result.receipt.sizeBytes, length); assert.equal(result.storedSize, length); assert.equal(result.readSize, length);
    assert.equal(result.receipt.sha256, expected); assert.equal(result.sha256, expected); assert.equal(result.contentType, "video/mp4");
    assert.ok(result.maximumChunk < 1024 * 1024);
  }
});

function controlRequest(base, endpoint) {
  return new Promise(resolve => {
    const began = performance.now();
    const request = http.request(base + endpoint, { method: endpoint === "/heartbeat" ? "POST" : "GET", agent: false }, response => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", value => { text += value; });
      response.on("end", () => {
        try { resolve({ endpoint, status: response.statusCode, elapsedMs: performance.now() - began, ...JSON.parse(text) }); }
        catch { resolve({ endpoint, status: response.statusCode, error: "invalid response" }); }
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error("control timeout")));
    request.on("error", error => resolve({ endpoint, error: error.message, elapsedMs: performance.now() - began }));
    request.end();
  });
}

test("real HTTP source uploads keep D1 control and heartbeat responsive before the helper completes", { timeout: 120000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-control-regression-"));
  const mf = new Miniflare({ modules: true, script: worker, host: "127.0.0.1", port: 0,
    compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"], r2Buckets: ["MEDIA"], d1Databases: ["DB"],
    r2Persist: path.join(directory, "r2"), d1Persist: path.join(directory, "d1") });
  t.after(async () => { await mf.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const database = await mf.getD1Database("DB");
  await database.exec("CREATE TABLE synthetic_control(id INTEGER PRIMARY KEY,sequence INTEGER); INSERT INTO synthetic_control VALUES(1,0)");
  const base = (await mf.ready).origin;
  assert.equal((await controlRequest(base, "/control")).status, 200);
  for (const length of [512 * 1024 * 1024, 1024 * 1024 * 1024]) {
    const polls = [], chunk = new Uint8Array(64 * 1024).fill(7); let remaining = length, uploading = true;
    const polling = (async () => {
      while (uploading) {
        const responses = await Promise.all([controlRequest(base, "/control"), controlRequest(base, "/heartbeat")]);
        polls.push(...responses);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const began = performance.now();
    let response, result;
    try {
      response = await fetch(base + "/upload-http", { method: "POST", headers: { "content-length": String(length) }, duplex: "half",
        body: new ReadableStream({ pull(controller) {
          if (!remaining) { controller.close(); return; }
          const count = Math.min(remaining, chunk.length); controller.enqueue(chunk.subarray(0, count)); remaining -= count;
        } }, { highWaterMark: 0 }) });
      result = await response.json();
    } finally { uploading = false; await polling; }
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.receipt.sizeBytes, length); assert.equal(result.storedSize, length);
    const hash = createHash("sha256");
    for (let rest = length; rest > 0; rest -= chunk.length) hash.update(chunk.subarray(0, Math.min(rest, chunk.length)));
    assert.equal(result.receipt.sha256, hash.digest("hex"));
    assert.ok(polls.every(poll => poll.status === 200 && !poll.error), JSON.stringify(polls.filter(poll => poll.error)));
    for (const endpoint of ["/control", "/heartbeat"]) {
      const concurrent = polls.filter(poll => poll.endpoint === endpoint && poll.inProgress === true);
      assert.ok(concurrent.length >= 2, `${endpoint} never completed during source transfer`);
      assert.ok(concurrent.every(poll => poll.elapsedMs < 2000), `${endpoint} exceeded its control timeout`);
    }
    const updates = await database.prepare("SELECT sequence FROM synthetic_control WHERE id=1").first();
    assert.ok(updates.sequence > 0);
    console.log(JSON.stringify({ length, uploadElapsedMs: Math.round(performance.now() - began),
      controlsDuringTransfer: polls.filter(poll => poll.endpoint === "/control" && poll.inProgress).length,
      heartbeatsDuringTransfer: polls.filter(poll => poll.endpoint === "/heartbeat" && poll.inProgress).length,
      maximumControlMs: Math.round(Math.max(...polls.map(poll => poll.elapsedMs))) }));
  }
});
