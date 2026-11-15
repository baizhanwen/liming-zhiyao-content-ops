import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

function checkpointBody(value) { const result = { ...value }; delete result._write_fence; return result; }

async function fixture(t, sourceType = "url") {
  const f = runtimeFixture(t), owner = await f.initialize(), now = new Date().toISOString();
  f.identity.userId = owner.userId;
  const projectId = crypto.randomUUID(), videoId = crypto.randomUUID(), jobId = crypto.randomUUID(), workerId = "checkpoint-worker";
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Checkpoint fixture','Synthetic',?,?,?,?)").run(projectId, owner.organizationId, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin',?,'https://example.invalid/source',?,?,?,?)").run(videoId, owner.organizationId, projectId, sourceType, owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,progress,lease_owner,lease_expires_at,attempt_count,version,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'checkpoint:fixture','transcribing',35,?,?,1,5,?,?,?,?)")
    .run(jobId, owner.organizationId, projectId, videoId, sourceType, "synthetic-source", workerId, new Date(Date.now() + 300000).toISOString(), owner.userId, owner.userId, now, now);
  f.mockModule("cloudflare:workers", { env: { ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  f.mock("lib/operations.ts", { getOrganizationCapacity: async () => ({ storage_quota_bytes: 100000000 }) });
  f.runtime.getProjectAccess = async () => ({ organizationRole: "admin" }); f.runtime.canWriteProjectAccess = () => true;
  const objects = new Map();
  let afterPut = async () => {};
  f.runtime.getMediaBucket = () => ({ put: async (key, bytes) => { objects.set(key, new Uint8Array(bytes)); await afterPut(); return { key }; }, delete: async key => objects.delete(key) });
  f.runtime.getMediaObject = async key => objects.has(key) ? { source: "primary", object: { body: objects.get(key), size: objects.get(key).byteLength, httpEtag: '"synthetic"', writeHttpMetadata: headers => headers.set("content-type", "video/mp4") } } : null;
  const headers = { authorization: "Bearer synthetic-service-token", "content-type": "application/json" };
  const request = body => new Request("http://localhost/internal", { method: "POST", headers, body: JSON.stringify(body) });
  const context = { params: Promise.resolve({ jobId }) };
  const asset = (id = crypto.randomUUID(), boundJobId = jobId) => {
    const bytes = new TextEncoder().encode("synthetic source bytes"), hash = createHash("sha256").update(bytes).digest("hex"), key = `synthetic/${id}`;
    objects.set(key, bytes);
    f.sqlite.prepare("INSERT INTO media_assets(id,organization_id,project_id,video_id,analysis_job_id,kind,r2_key,filename,content_type,size_bytes,sha256,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,'source_video',?,'source.mp4','video/mp4',?,?,'active',?,?,?,?)")
      .run(id, owner.organizationId, projectId, videoId, boundJobId, key, bytes.byteLength, hash, owner.userId, owner.userId, now, now);
    return { id, sha256: hash, size_bytes: bytes.byteLength, kind: "source_video" };
  };
  const sourceAsset = asset();
  if (sourceType === "upload") {
    f.sqlite.prepare("UPDATE media_assets SET analysis_job_id=NULL WHERE id=?").run(sourceAsset.id);
    f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(sourceAsset.id, videoId);
    f.sqlite.prepare("UPDATE analysis_jobs SET source_ref=? WHERE id=?").run(sourceAsset.id, jobId);
  }
  const checkpoint = {
    checkpoint_version: 2, transcript_review_enabled: true, source_asset: sourceAsset,
    asr_fingerprint: "a".repeat(64), transcript_sha256: "b".repeat(64), manual_source_hash: null,
    media: { duration_ms: 360000, width: 1080, height: 1920, video_codec: "h264", audio_codec: "aac" },
    transcript: { language: "zh-CN", confidence: null, segments: [{ start_ms: 0, end_ms: 1000, text: "合成原始转写", confidence: null }] },
  };
  const save = (overrides = {}) => f.load("app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts").POST(request({ workerId, version: 1, attempt: 1, stage: "transcript_ready", checkpoint, ...overrides }), context);
  const download = (id = sourceAsset.id, attempt = 1) => f.load("app/api/internal/analysis-jobs/[jobId]/source/route.ts").GET(new Request(`http://localhost/source?assetId=${encodeURIComponent(id)}`, { headers: { authorization: headers.authorization, "x-worker-id": workerId, "x-worker-attempt": String(attempt) } }), context);
  const upload = (extra = {}) => f.load("app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts").POST(new Request("http://localhost/artifacts", { method: "POST", headers: { ...headers, "x-worker-id": workerId, "x-job-version": "1", "x-worker-attempt": "1", "x-artifact-kind": "report", "x-artifact-filename": "synthetic.json", ...extra }, body: "{}" }), context);
  const heartbeat = async () => {
    const version = f.sqlite.prepare("SELECT version FROM analysis_jobs WHERE id=?").get(jobId).version;
    const result = await f.load("app/api/internal/analysis-jobs/[jobId]/heartbeat/route.ts").POST(request({ workerId, version, status: "transcribing", progress: 36, stage: "合成心跳进度" }), context);
    assert.equal(result.status, 200, await result.clone().text());
  };
  return { ...f, owner, projectId, videoId, jobId, workerId, sourceAsset, asset, checkpoint, request, context, save, download, upload, heartbeat, objects, onPut: callback => { afterPut = callback; } };
}

test("raw ASR checkpoint saves before visual work and survives a heartbeat version advance", async t => {
  const f = await fixture(t);
  await f.heartbeat();
  assert.equal((await f.save()).status, 201);
  const row = f.sqlite.prepare("SELECT checkpoint_stage,checkpoint_json,version FROM analysis_jobs WHERE id=?").get(f.jobId);
  assert.equal(row.checkpoint_stage, "transcript_ready"); assert.equal(row.version, 6);
  assert.deepEqual(checkpointBody(JSON.parse(row.checkpoint_json)), f.checkpoint);
  assert.equal((await f.save({ attempt: undefined })).status, 409, "Legacy writers retain exact-version fencing");
});

test("URL and uploaded sources download from the stored asset without reacquiring the public URL", async t => {
  for (const type of ["url", "upload"]) {
    const f = await fixture(t, type), result = await f.download();
    assert.equal(result.status, 200); assert.equal(await result.text(), "synthetic source bytes");
    assert.equal((await f.download(f.sourceAsset.id, 2)).status, 409);
  }
});

test("a source read refuses a cancelled execution even if object lookup was already in flight", async t => {
  const f = await fixture(t), get = f.runtime.getMediaObject;
  f.runtime.getMediaObject = async (...args) => {
    const result = await get(...args);
    f.sqlite.prepare("UPDATE analysis_jobs SET status='cancelled' WHERE id=?").run(f.jobId);
    return result;
  };
  assert.equal((await f.download()).status, 409);
});

test("transcript checkpoint rejects mismatched hashes, unrelated assets and malformed metadata", async t => {
  const f = await fixture(t);
  for (const checkpoint of [
    { ...f.checkpoint, asr_fingerprint: "invalid" },
    { ...f.checkpoint, transcript_sha256: null },
    { ...f.checkpoint, transcript: { ...f.checkpoint.transcript, segments: [{ start_ms: 10, end_ms: 0, text: "invalid" }] } },
  ]) assert.equal((await f.save({ checkpoint })).status, 400);
  assert.equal((await f.save({ checkpoint: { ...f.checkpoint, source_asset: { ...f.sourceAsset, sha256: "f".repeat(64) } } })).status, 409);
  const otherJob = crypto.randomUUID();
  f.sqlite.prepare("INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,created_by,updated_by,created_at,updated_at) SELECT ?,organization_id,project_id,video_id,source_type,source_ref,'other:fixture','failed',created_by,updated_by,created_at,updated_at FROM analysis_jobs WHERE id=?").run(otherJob, f.jobId);
  const unrelated = f.asset(crypto.randomUUID(), otherJob);
  assert.equal((await f.download(unrelated.id)).status, 409);
  assert.equal((await f.save({ checkpoint: { ...f.checkpoint, source_asset: unrelated } })).status, 409);
});

test("an old ASR receipt cannot downgrade a newer evidence checkpoint", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='extracting',checkpoint_stage='evidence_ready',checkpoint_json='{}' WHERE id=?").run(f.jobId);
  const response = await f.save(); assert.equal(response.status, 200); assert.equal((await response.json()).superseded, true);
  assert.equal(f.sqlite.prepare("SELECT checkpoint_stage FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_stage, "evidence_ready");
});

test("manual retry and the next claim retain the raw checkpoint and advertise source recovery", async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 201);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(f.jobId);
  const retry = await f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(f.request({}), f.context);
  assert.equal(retry.status, 200, await retry.clone().text());
  const response = await f.load("app/api/internal/analysis-jobs/claim/route.ts").POST(f.request({ workerId: f.workerId }));
  assert.equal(response.status, 200, await response.clone().text());
  const claimed = (await response.json()).job;
  assert.equal(claimed.attempt_count, 2); assert.equal(claimed.resume_count, 1);
  assert.equal(claimed.checkpoint_stage, "transcript_ready"); assert.deepEqual(checkpointBody(claimed.checkpoint), f.checkpoint);
  assert.match(claimed.current_stage, /复用原片和口播稿/);
});

test("partial completion keeps an earlier raw checkpoint when the full evidence checkpoint was unavailable", async t => {
  const f = await fixture(t); assert.equal((await f.save()).status, 201);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(f.jobId);
  const complete = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(f.request({ workerId: f.workerId, version: 5, resultKey: "transcript:partial-result", analysis: { schemaVersion: "analysis.v12", report: {}, confidence: null } }), f.context);
  assert.equal(complete.status, 200, await complete.clone().text()); assert.equal((await complete.json()).job.status, "partial");
  const row = f.sqlite.prepare("SELECT checkpoint_stage,checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId);
  assert.equal(row.checkpoint_stage, "transcript_ready"); assert.deepEqual(checkpointBody(JSON.parse(row.checkpoint_json)), f.checkpoint);
  const route = f.load("app/api/analysis-jobs/[jobId]/retry/route.ts");
  assert.equal((await route.POST(f.request({ moduleKeys: ["visual"] }), f.context)).status, 409, "Raw ASR alone cannot promise selective paid-module reuse");
  const retry = await route.POST(f.request({}), f.context);
  assert.equal(retry.status, 200, await retry.clone().text());
  const pending = f.sqlite.prepare("SELECT progress,current_stage FROM analysis_jobs WHERE id=?").get(f.jobId);
  assert.equal(pending.progress, 0); assert.match(pending.current_stage, /复用已保存原片与口播稿/);
});

test("artifact upload survives concurrent real heartbeat while keeping attempt identity", async t => {
  const f = await fixture(t); f.onPut(f.heartbeat);
  const response = await f.upload(); assert.equal(response.status, 201, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE kind='report'").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT version FROM analysis_jobs WHERE id=?").get(f.jobId).version, 6);
});

for (const [name, mutation] of [
  ["cancelled", "status='cancelled'"], ["new worker", "lease_owner='replacement-worker'"], ["new attempt on the same worker", "attempt_count=2"],
]) test(`old execution cannot save checkpoints or upload after ${name}`, async t => {
  const f = await fixture(t);
  f.onPut(async () => f.sqlite.prepare(`UPDATE analysis_jobs SET ${mutation} WHERE id=?`).run(f.jobId));
  assert.equal((await f.upload()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE kind='report'").get().n, 0);
  assert.equal(f.objects.size, 1, "Only the original persisted source remains");
  assert.equal((await f.save()).status, 409);
  assert.equal((await f.download()).status, 409);
});

test("legacy artifact writers retain strict revision checks during heartbeat races", async t => {
  const f = await fixture(t); f.onPut(f.heartbeat);
  assert.equal((await f.upload({ "x-job-version": "5", "x-worker-attempt": "" })).status, 400);
  const response = await f.load("app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts").POST(new Request("http://localhost/artifact", { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json", "x-worker-id": f.workerId, "x-job-version": "5", "x-artifact-kind": "report", "x-artifact-filename": "legacy.json" }, body: "{}" }), f.context);
  assert.equal(response.status, 409); assert.equal(f.objects.size, 1);
});

function evidenceCheckpoint(keys) {
  return { checkpoint_version: 1, media: {}, transcript: {}, visuals: {}, unified_progress: {
    source_signature: "a".repeat(64), canonical: { status: "completed" },
    modules: Object.fromEntries(keys.map(key => [key, { status: "completed", signature: "b".repeat(64) }])),
  } };
}

test("late baseline, empty progress and subset checkpoints cannot erase this execution's paid modules", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing',version=8 WHERE id=?").run(f.jobId);
  const complete = evidenceCheckpoint(["topic", "visual"]);
  assert.equal((await f.save({ stage: "evidence_ready", version: 8, checkpoint: complete })).status, 201);
  const baseline = { ...complete }; delete baseline.unified_progress;
  for (const checkpoint of [baseline, evidenceCheckpoint([]), evidenceCheckpoint(["topic"])]) {
    const response = await f.save({ stage: "evidence_ready", version: 2, checkpoint });
    assert.equal(response.status, 200); assert.equal((await response.json()).superseded, true);
    assert.deepEqual(checkpointBody(JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json)), complete);
  }
  const repaired = evidenceCheckpoint(["topic", "visual"]);
  repaired.unified_progress.modules.visual.signature = "c".repeat(64);
  assert.equal((await f.save({ stage: "evidence_ready", checkpoint: repaired })).status, 201, "Canonical repair may update a module input signature while retaining all completed keys");
});

test("a new attempt may rebuild an older attempt's evidence cache", async t => {
  const f = await fixture(t); f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(f.jobId);
  assert.equal((await f.save({ stage: "evidence_ready", checkpoint: evidenceCheckpoint(["visual"]) })).status, 201);
  f.sqlite.prepare("UPDATE analysis_jobs SET attempt_count=2 WHERE id=?").run(f.jobId);
  const baseline = { checkpoint_version: 1, media: {}, transcript: {}, visuals: {} };
  assert.equal((await f.save({ stage: "evidence_ready", attempt: 2, checkpoint: baseline })).status, 201);
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  assert.deepEqual(checkpointBody(saved), baseline); assert.equal(saved._write_fence.attempt, 2);
});

test("segment recovery protects completed window identities rather than just their count", async t => {
  const f = await fixture(t); f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(f.jobId);
  const checkpoint = keys => ({ checkpoint_version: 1, segment_progress: { segments: keys.map(window_key => ({ window_key, status: "completed" })) } });
  assert.equal((await f.save({ stage: "segment_progress", checkpoint: checkpoint(["A", "B"]) })).status, 201);
  const response = await f.save({ stage: "segment_progress", checkpoint: checkpoint(["A", "C"]) });
  assert.equal(response.status, 200); assert.equal((await response.json()).superseded, true);
  assert.deepEqual(checkpointBody(JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json)), checkpoint(["A", "B"]));
});

test("competing module snapshots cannot overwrite successes committed after their shared initial read", async t => {
  const f = await fixture(t); f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing' WHERE id=?").run(f.jobId);
  assert.equal((await f.save({ stage: "evidence_ready", checkpoint: evidenceCheckpoint(["topic"]) })).status, 201);
  const prepare = f.db.prepare; let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.db.prepare = sql => {
    const statement = prepare(sql), first = statement.first;
    if (sql.includes("SELECT j.id") && sql.includes("j.checkpoint_json")) statement.first = async () => {
      const snapshot = await first();
      if (++arrivals <= 2) { if (arrivals === 2) release(); await barrier; }
      return snapshot;
    };
    return statement;
  };
  const responses = await Promise.all([
    f.save({ stage: "evidence_ready", checkpoint: evidenceCheckpoint(["topic", "visual"]) }),
    f.save({ stage: "evidence_ready", checkpoint: evidenceCheckpoint(["topic", "expression"]) }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.equal(bodies.filter(body => body.superseded).length, 1);
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  const winner = responses[0].status === 201 ? ["topic", "visual"] : ["topic", "expression"];
  assert.deepEqual(Object.keys(saved.unified_progress.modules), winner);
  const forward = await f.save({ stage: "evidence_ready", checkpoint: evidenceCheckpoint(["topic", "visual", "expression"]) });
  assert.equal(forward.status, 201);
});
