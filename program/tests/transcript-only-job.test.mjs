import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const serviceToken = "synthetic-transcript-service";
async function fixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: serviceToken } });
  const owner = await f.initialize();
  f.identity.userId = owner.userId;
  const now = new Date().toISOString(), projectId = "test-project", videoId = "test-video", assetId = "original";
  const seed = (table, extra) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const fields = Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, project_id: projectId,
      created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...extra }).filter(([key]) => columns.has(key));
    f.sqlite.prepare(`INSERT INTO ${table} (${fields.map(([key]) => key)}) VALUES (${fields.map(() => "?")})`).run(...fields.map(([,v]) => v));
  };
  seed("projects", { id: projectId, name: "Test", client_name: "Test" });
  seed("videos", { id: videoId, source_url: "https://example.invalid/clip", platform: "douyin", source_type: "url", status: "ready" });
  seed("media_assets", { id: assetId, video_id: videoId, kind: "source_video", r2_key: "original-data", filename: "original.mp4", content_type: "video/mp4", size_bytes: 4, sha256: "synthetic" });
  f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(assetId, videoId);
  seed("video_analyses", { video_id: videoId, schema_version: "analysis.v1", report_json: '{"existing":true}' });
  f.runtime.getProjectAccess = async () => ({ userId: owner.userId, organizationRole: "admin" });
  f.runtime.canWriteProjectAccess = () => true;
  f.runtime.getMediaBucket = () => ({ head: async key => key === "original-data" ? { size: 4 } : null });
  f.runtime.getLegacyMediaBucket = () => null;
  const source = (endpoint, body) => new Request("http://localhost/" + endpoint, {
    method: "POST", headers: { authorization: "Bearer " + serviceToken }, body: JSON.stringify(body),
  });
  const claim = () => f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(source("claim", { workerId: "test-worker" }));
  const enqueue = (task) => f.load("app/api/videos/[videoId]/reanalyze/route.ts").POST(
    source("reanalyze", { organizationId: owner.organizationId, projectId, task }), { params: Promise.resolve({ videoId }) });
  const complete = (job, overrides={}) => f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(source("complete", {
    workerId: "test-worker", resultKey: "transcript:test-result", version: job.version,
    analysis: { schemaVersion: "transcript.v1", report: {}, confidence: null },
    transcript: { language: "zh", confidence: null, fullText: "一份完整口播", segments: [{ start_ms: 0, end_ms: 1300, text: "一份完整口播" }] },
    ...overrides,
  }), { params: Promise.resolve({ jobId: job.id }) });
  return { ...f, assetId, videoId, enqueue, claim, complete };
}

test("a local transcription uses saved URL media without cloud credentials and preserves existing analysis", async t => {
  const f = await fixture(t);
  assert.equal((await f.claim()).status, 204);
  assert.equal((await f.enqueue()).status, 503);
  assert.equal((await f.enqueue("transcript")).status, 201);
  assert.equal((await f.enqueue("transcript")).status, 409);
  const job = (await (await f.claim()).json()).job;
  assert.equal(job.source_type, "upload");
  assert.equal(job.source_ref, f.assetId);
  assert.equal(job.source.transcript_only, true);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='extracting' WHERE id=?").run(job.id);
  assert.equal((await f.complete(job, { workerId: "wrong-worker" })).status, 409);
  assert.equal((await f.complete(job, { version: job.version-1 })).status, 409);
  assert.equal((await f.complete(job, { transcript: null })).status, 400);
  assert.equal((await f.complete(job, { analysis: { schemaVersion: "analysis.v1", report: {}, confidence: null } })).status, 409);
  assert.equal((await f.complete(job)).status, 200);
  assert.equal((await (await f.complete(job)).json()).idempotent, true);
  assert.deepEqual(f.sqlite.prepare("SELECT full_text FROM video_transcripts").all().map(r=>r.full_text), ["一份完整口播"]);
  assert.deepEqual(f.sqlite.prepare("SELECT report_json FROM video_analyses").all().map(r=>r.report_json), ['{"existing":true}']);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM video_knowledge_atoms").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM project_memory_events").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM analysis_job_events WHERE event_type='completed'").get().n, 1);
});

test("a URL without a usable local object can be collected, while a missing upload is rejected", async t => {
  const f = await fixture(t);
  await f.claim();
  f.runtime.getMediaBucket = () => ({ head: async () => null });
  f.sqlite.prepare("UPDATE videos SET source_type='upload' WHERE id=?").run(f.videoId);
  assert.equal((await f.enqueue("transcript")).status, 409);
  f.sqlite.prepare("UPDATE videos SET source_type='url' WHERE id=?").run(f.videoId);
  assert.equal((await f.enqueue("transcript")).status, 201);
  assert.equal((await (await f.claim()).json()).job.source_type, "url");
});
