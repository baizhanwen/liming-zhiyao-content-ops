import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const start = "2026-11-10T01:00:00.000Z";
const later = "2026-11-10T01:00:30.000Z";
const ended = "2026-11-10T01:00:20.000Z";

test("safe observations discard all free text, supplier data and malformed counters", t => {
  const { load } = runtimeFixture(t);
  const { safeProgressObservation } = load("lib/analysis-task-progress.ts");
  assert.deepEqual(safeProgressObservation({ phase: "browser", url: "https://private.invalid", headers: { Authorization: "synthetic-secret" }, detail: "private", metrics: { requests: 2, downloaded_bytes: 8192, proxy_bytes: -1, total: true, completed: 1.2, files_total: Number.MAX_SAFE_INTEGER + 1, secret: 3 } }), { phase: "browser", metrics: { downloaded_bytes: 8192, requests: 2 } });
  assert.equal(safeProgressObservation({ phase: "https://private.invalid" }), null);
  assert.equal(safeProgressObservation({ phase: [] }), null);
});

test("polling and identical heartbeat observations do not create progress", t => {
  const { load } = runtimeFixture(t);
  const { nextTaskProgress, taskProgressSnapshot } = load("lib/analysis-task-progress.ts");
  const observation = { phase: "browser", metrics: { requests: 2 } };
  const job = { status: "downloading", started_at: start, stage_started_at: start, last_progress_at: start, progress_json: JSON.stringify(observation), lease_owner: "worker-1", lease_expires_at: "2026-11-10T01:05:00.000Z", last_heartbeat_at: later, attempt_count: 2 };
  const unchanged = nextTaskProgress(job, job.status, observation, later);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.lastProgressAt, start);
  assert.equal(unchanged.stageStartedAt, start);
  assert.equal(nextTaskProgress(job, job.status, null, later).lastProgressAt, start);
  const legacyHeartbeat = nextTaskProgress({ status: "analyzing" }, "analyzing", null, later);
  assert.equal(legacyHeartbeat.changed, false);
  assert.equal(legacyHeartbeat.lastProgressAt, null);
  assert.equal(legacyHeartbeat.stageStartedAt, null);
  const first = taskProgressSnapshot(job, ended), second = taskProgressSnapshot(job, later);
  assert.equal(first.lastProgressAt, second.lastProgressAt);
  assert.equal(second.elapsedSeconds, 30);
  assert.equal(second.stageElapsedSeconds, 30);
  assert.equal(second.activityAgeSeconds, 30);
  assert.equal(second.executionCount, 2);
  assert.equal(second.workerActive, true);
  const advanced = nextTaskProgress(job, job.status, { phase: "browser", metrics: { requests: 3 } }, later);
  assert.equal(advanced.lastProgressAt, later);
  assert.equal(advanced.stageStartedAt, start);
  assert.equal(nextTaskProgress(job, job.status, { phase: "validating_media", metrics: {} }, later).stageStartedAt, later);
});

test("failure, cancellation and completion clocks freeze; legacy clocks and attempts remain unknown", t => {
  const { load } = runtimeFixture(t);
  const { taskProgressSnapshot } = load("lib/analysis-task-progress.ts");
  for (const status of ["completed", "partial", "failed", "cancelled"]) {
    const job = { status, started_at: start, stage_started_at: start, completed_at: ended, updated_at: ended, attempt_count: 3 };
    const first = taskProgressSnapshot(job, later), second = taskProgressSnapshot(job, "2026-11-11T01:00:00.000Z");
    assert.equal(first.elapsedSeconds, 20);
    assert.equal(first.stageElapsedSeconds, 20);
    assert.equal(second.elapsedSeconds, first.elapsedSeconds);
    assert.equal(second.workerActive, false);
  }
  const legacy = taskProgressSnapshot({ status: "failed", created_at: start, updated_at: ended, retry_count: 8 }, later);
  assert.equal(legacy.startedAt, null);
  assert.equal(legacy.elapsedSeconds, null);
  assert.equal(legacy.executionCount, null);
  const pending = taskProgressSnapshot({ status: "pending", attempt_count: 3 }, later);
  assert.equal(pending.elapsedSeconds, null);
  assert.equal(pending.phase, "queued");
});

test("expired leases stop accumulating processing time and never claim a live worker", t => {
  const { load } = runtimeFixture(t);
  const { taskProgressSnapshot } = load("lib/analysis-task-progress.ts");
  const result = taskProgressSnapshot({ status: "analyzing", started_at: start, stage_started_at: start, lease_expires_at: ended, last_heartbeat_at: start, lease_owner: "worker-1" }, later);
  assert.equal(result.workerActive, false);
  assert.equal(result.elapsedSeconds, 20);
});

async function routeFixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  const i = await f.initialize(); f.identity.userId = i.userId;
  f.runtime.getProjectAccess = async () => ({ projectRole: "member" });
  f.runtime.canWriteProjectAccess = () => true;
  f.mock("lib/analyzer-readiness.ts", { readAnalyzerReadiness: async () => ({}) });
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: i.organizationId, project_id: "test-project", created_by: i.userId, updated_by: i.userId, created_at: start, updated_at: start, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: "test-project", name: "Test", client_name: "Test" });
  const video = seed("videos", { platform: "douyin", source_type: "url", source_url: "https://www.douyin.com/video/1234567890123456789" });
  const jobId = seed("analysis_jobs", { video_id: video, source_type: "url", source_ref: "synthetic-source", idempotency_key: crypto.randomUUID() });
  const post = (path, body = {}) => f.load(`app/api/${path.replace(jobId, "[jobId]")}/route.ts`).POST(new Request(`http://localhost/api/${path}`, { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ jobId }) });
  const claim = () => post("internal/analysis-jobs/claim", { workerId: "test-worker", leaseSeconds: 300 });
  const job = () => f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(jobId);
  const list = () => f.load("app/api/videos/route.ts").GET(new Request(`http://localhost/api/videos?organizationId=${i.organizationId}&projectId=test-project`));
  return { ...f, jobId, post, claim, job, list };
}

test("real routes persist measured starts, safe observations and frozen cancel/fail clocks across retries", async t => {
  const f = await routeFixture(t);
  assert.equal((await f.claim()).status, 200);
  assert.equal(f.job().attempt_count, 1);
  assert.ok(f.job().started_at);
  const heartbeat = { workerId: "test-worker", version: f.job().version, status: "downloading", progress: 8, stage: "正在采集", observation: { phase: "browser", requests: 2, url: "https://private.invalid", headers: { Authorization: "synthetic-private" } } };
  assert.equal((await f.post(`internal/analysis-jobs/${f.jobId}/heartbeat`, heartbeat)).status, 200);
  assert.deepEqual(JSON.parse(f.job().progress_json), { phase: "browser", metrics: { requests: 2 } });
  f.sqlite.prepare("UPDATE analysis_jobs SET last_progress_at = ?, stage_started_at = ? WHERE id = ?").run(start, start, f.jobId);
  assert.equal((await f.post(`internal/analysis-jobs/${f.jobId}/heartbeat`, { ...heartbeat, version: f.job().version })).status, 200);
  assert.equal(f.job().last_progress_at, start);
  assert.equal(f.job().stage_started_at, start);
  const before = f.job();
  for (let n = 0; n < 2; n++) {
    const response = await f.list(); assert.equal(response.status, 200);
    const output = (await response.json()).jobs[0];
    assert.equal(output.taskProgress.lastProgressAt, start);
    assert.equal(output.taskProgress.executionCount, 1);
    assert.equal(output.taskProgress.workerActive, true);
    assert.equal(output.progress_json, undefined);
    assert.equal(output.lease_owner, undefined);
    assert.doesNotMatch(JSON.stringify(output.taskProgress), /private|Authorization/);
  }
  assert.deepEqual(f.job(), before);
  assert.equal((await f.post(`analysis-jobs/${f.jobId}/cancel`)).status, 200);
  assert.equal(f.job().status, "cancelled"); assert.ok(f.job().completed_at);
  const { taskProgressSnapshot } = f.load("lib/analysis-task-progress.ts");
  assert.equal(taskProgressSnapshot(f.job(), "2030-01-01T00:00:00Z").elapsedSeconds, taskProgressSnapshot(f.job()).elapsedSeconds);
  assert.equal((await f.post(`analysis-jobs/${f.jobId}/retry`)).status, 200);
  assert.equal(f.job().started_at, null); assert.equal(f.job().completed_at, null);
  assert.equal(f.job().attempt_count, 1);
  assert.equal(taskProgressSnapshot(f.job()).queuedAt, f.job().last_progress_at);
  assert.equal((await f.claim()).status, 200); assert.equal(f.job().attempt_count, 2);
  assert.equal((await f.post(`internal/analysis-jobs/${f.jobId}/fail`, { workerId: "test-worker", version: f.job().version, resultKey: "result:test-failure", errorCode: "TEST_FAILURE", errorMessage: "Synthetic failure", progress: f.job().progress, stage: "分析失败" })).status, 200);
  assert.equal(f.job().status, "failed"); assert.ok(f.job().completed_at);
  assert.equal(taskProgressSnapshot(f.job(), "2030-01-01T00:00:00Z").elapsedSeconds, taskProgressSnapshot(f.job()).elapsedSeconds);
});

test("pending queue clocks use the latest retry, with legacy retries remaining unknown", t => {
  const { taskProgressSnapshot } = runtimeFixture(t).load("lib/analysis-task-progress.ts");
  assert.equal(taskProgressSnapshot({ status: "pending", created_at: start, attempt_count: 0 }, later).queuedAt, start);
  assert.equal(taskProgressSnapshot({ status: "pending", created_at: start, last_progress_at: ended, attempt_count: 2 }, later).queuedAt, ended);
  assert.equal(taskProgressSnapshot({ status: "pending", created_at: start, attempt_count: 2 }, later).queuedAt, null);
});

test("accepted completion freezes clocks and a repeated result acknowledgement preserves them", async t => {
  const f = await routeFixture(t);
  f.mock("lib/video-knowledge-atoms.ts", { extractVideoKnowledgeAtoms: async () => {} });
  f.mock("lib/benchmark-memory-events.ts", { enqueueBenchmarkVideoAnalysisMemoryEventsWithDb: async () => {} });
  assert.equal((await f.claim()).status, 200);
  for (const [status, phase, progress] of [["downloading", "public_page", 5], ["processing", "audio_chunks", 18], ["transcribing", "model_transcription", 35], ["extracting", "saving", 70], ["analyzing", "model_analysis", 84]]) {
    assert.equal((await f.post(`internal/analysis-jobs/${f.jobId}/heartbeat`, { workerId: "test-worker", version: f.job().version, status, progress, stage: "Synthetic stage", observation: { phase } })).status, 200);
  }
  const payload = { workerId: "test-worker", version: f.job().version, resultKey: "result:test-completed", analysis: { schemaVersion: "analysis.v1", report: { summary: "Synthetic report" }, confidence: null } };
  const complete = await f.post(`internal/analysis-jobs/${f.jobId}/complete`, payload);
  assert.equal(complete.status, 200); assert.equal(f.job().status, "completed");
  const finished = f.job(); assert.ok(finished.completed_at);
  assert.equal((await f.post(`internal/analysis-jobs/${f.jobId}/complete`, payload)).status, 200);
  assert.deepEqual(f.job(), finished);
  const { taskProgressSnapshot } = f.load("lib/analysis-task-progress.ts");
  assert.equal(taskProgressSnapshot(finished).elapsedSeconds, taskProgressSnapshot(finished, "2030-01-01T00:00:00Z").elapsedSeconds);
  assert.equal(taskProgressSnapshot(finished).phase, "complete");
});
