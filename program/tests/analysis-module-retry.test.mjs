import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { unifiedAnalysisReportFixture, analysisReportFixture } from "./helpers/content-analysis-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: { DELIVERY_MODE: "1", FIRST_RUN_SETUP_CODE: "synthetic-test-code", ANALYZER_SERVICE_TOKEN: "synthetic-service-token" } });
  const owner = await f.initialize(); f.identity.userId = owner.userId;
  f.runtime.getProjectAccess = async () => ({ organizationRole: "admin", projectRole: "owner" });
  f.runtime.canWriteProjectAccess = () => true;
  const projectId = "module-project", videoId = "module-video", jobId = "module-job", now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(projectId, owner.organizationId, "Synthetic", "Synthetic", owner.userId, owner.userId, now, now);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(videoId, owner.organizationId, projectId, "douyin", "url", "https://example.invalid/video", owner.userId, owner.userId, now, now);
  const report = unifiedAnalysisReportFixture();
  report.unified_report.status = report.content_analysis.status = "partial";
  report.unified_report.validation = report.content_analysis.validation = { passed: false, issues: ["visual:provider_error"] };
  Object.assign(report.content_analysis.module_status.visual, { status: "failed", reason: "classification_request_failed", validation: { passed: false, issues: ["classification_request_failed"] } });
  Object.assign(report.unified_report.sections[2], { status: "failed", reason: "classification_request_failed", findings: [] });
  Object.assign(report.unified_report.sections[2].diagnostics, { failure_kind: "provider_error", http_status: 503, attempts: 2 });
  const checkpoint = { checkpoint_version: 1, media: { normalized_path: "isolated-original.mp4" }, transcript: { full_text: "保留全文" }, visuals: { observations: [] },
    unified_progress: { version: "unified-progress.v1", protocol_version: "unified-analysis.v1", source_signature: report.unified_report.source_signature,
      canonical: { status: "completed", sentinel: "canonical-cache-preserved" }, modules: { text_topic_structure_audience: { status: "completed", signature: "signed-topic", validation: { passed: true, issues: [] }, response: { sentinel: "successful-module-preserved" } } } } };
  f.sqlite.prepare(`INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,checkpoint_stage,checkpoint_json,created_by,updated_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'partial','evidence_ready',?,?,?,?,?)`).run(jobId, owner.organizationId, projectId, videoId, "url", "https://example.invalid/video", "module-test-job", JSON.stringify(checkpoint), owner.userId, owner.userId, now, now);
  const saveReport = (body = report, schema = "analysis.v11", created = now) => f.sqlite.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,analysis_job_id,schema_version,report_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), owner.organizationId, projectId, videoId, jobId, schema, JSON.stringify(body), owner.userId, created, created);
  saveReport();
  const retry = (payload = {}) => f.load("app/api/analysis-jobs/[jobId]/retry/route.ts").POST(new Request("http://localhost/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), { params: Promise.resolve({ jobId }) });
  return { ...f, owner, projectId, videoId, jobId, report, checkpoint, saveReport, retry };
}

test("module retry preserves acquired evidence and successful caches and creates one guarded queue transition", async t => {
  const f = await fixture(t), response = await f.retry({ moduleKeys: ["visual"] });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).job.moduleKeys, ["visual"]);
  const job = f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), checkpoint = JSON.parse(job.checkpoint_json);
  assert.equal(job.status, "pending"); assert.equal(job.version, 1); assert.equal(job.retry_count, 1);
  assert.deepEqual(checkpoint.unified_progress, f.checkpoint.unified_progress);
  assert.deepEqual(checkpoint.media, f.checkpoint.media);
  assert.deepEqual(checkpoint.retry_module_keys, ["visual"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_analyses").get().n, 1);
  assert.equal((await f.retry()).status, 409);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='analysis_job.retried'").get().n, 1);
});

test("default v11 retry selects actual failed modules and refuses success or conflicting targets", async t => {
  const f = await fixture(t);
  assert.equal((await f.retry({ moduleKeys: ["synthesis"] })).status, 409);
  assert.equal((await f.retry({ moduleKeys: ["canonical"] })).status, 409);
  for (const moduleKeys of [[], ["foreign"], "visual"]) assert.equal((await f.retry({ moduleKeys })).status, 400);
  assert.equal((await f.retry({ moduleKeys: ["visual"], scriptVersion: "light_rewrite" })).status, 400);
  const response = await f.retry(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).job.moduleKeys, ["visual"]);
});

test("retry reads the latest same-job report and rejects stale source signatures", async t => {
  const f = await fixture(t), newer = structuredClone(f.report);
  newer.unified_report.source_signature = "b".repeat(64);
  f.saveReport(newer, "analysis.v11", "2099-01-01");
  const response = await f.retry({ moduleKeys: ["visual"] }); assert.equal(response.status, 409);
  assert.equal(f.sqlite.prepare("SELECT status FROM analysis_jobs WHERE id=?").get(f.jobId).status, "partial");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_analyses").get().n, 2);
});

test("canonical failure is separately retryable without labelling absent cache entries failed", async t => {
  const f = await fixture(t), report = structuredClone(f.report);
  report.unified_report.canonical.status = "failed"; report.unified_report.canonical.validation = { passed: false, issues: ["facts_changed"] };
  f.saveReport(report, "analysis.v11", "2099-01-01");
  assert.equal((await f.retry({ moduleKeys: ["visual"] })).status, 409, "Dependent modules wait for a valid canonical transcript");
  const response = await f.retry(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).job.moduleKeys, ["canonical"]);
});

test("blocked synthesis cannot be retried alone but an explicit all-failed retry can repair its dependencies", async t => {
  const f = await fixture(t), report = structuredClone(f.report);
  Object.assign(report.content_analysis.module_status.synthesis, { status: "failed", reason: "upstream_module_failed", validation: { passed: false, issues: ["upstream_module_failed"] } });
  Object.assign(report.unified_report.sections[3], { status: "failed", findings: [], reason: "upstream_module_failed" });
  f.saveReport(report, "analysis.v11", "2099-01-01");
  const detail = await f.load("app/api/videos/[videoId]/route.ts").GET(new Request(`http://localhost/detail?organizationId=${f.owner.organizationId}&projectId=${f.projectId}`), { params: Promise.resolve({ videoId: f.videoId }) });
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).job.module_retry.failedModuleKeys, ["visual"], "Do not display an unusable standalone synthesis button");
  const blocked = await f.retry({ moduleKeys: ["synthesis"] }); assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "MODULE_DEPENDENCY_INCOMPLETE");
  const all = await f.retry(); assert.equal(all.status, 200);
  assert.deepEqual((await all.json()).job.moduleKeys, ["visual", "synthesis"]);
});

test("permission revocation before the batch prevents retry, audit and checkpoint mutation", async t => {
  const f = await fixture(t), before = f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.prepare("UPDATE organization_members SET status='inactive'").run(); return batch(statements); };
  assert.equal((await f.retry({ moduleKeys: ["visual"] })).status, 403);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), before);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='analysis_job.retried'").get().n, 0);
});

test("v10 partial evidence remains resumable for upgrade without fabricated module targets", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("DELETE FROM video_analyses").run(); f.saveReport(analysisReportFixture(), "analysis.v10");
  const checkpoint = { ...f.checkpoint }; delete checkpoint.unified_progress;
  f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=?").run(JSON.stringify(checkpoint));
  assert.equal((await f.retry({ moduleKeys: ["visual"] })).status, 409);
  const response = await f.retry(); assert.equal(response.status, 200);
  assert.equal((await response.json()).job.moduleKeys, null);
  assert.deepEqual(JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs").get().checkpoint_json), checkpoint);
});

for (const variant of ["same", "language", "fullText", "segments", "confidence", "manual", "fresh"]) test(`module completion reuses only an exactly identical ASR: ${variant}`, async t => {
  const f = await fixture(t), now = new Date().toISOString(), source = variant === "manual" ? "manual" : "asr";
  const raw = { language: "zh-CN", fullText: "合成测试原文，只用于隔离验收。", segments: [{ start_ms: 0, end_ms: 1000, text: "合成测试原文，只用于隔离验收。" }], confidence: null };
  f.sqlite.prepare(`INSERT INTO video_transcripts(id,organization_id,project_id,video_id,version,language,source,full_text,segments_json,confidence,created_by,created_at,updated_at)
    VALUES('existing-asr',?,?,?,1,?,?,?,?,?,?,?,?)`).run(f.owner.organizationId, f.projectId, f.videoId, raw.language, source, raw.fullText, JSON.stringify(raw.segments), raw.confidence, f.owner.userId, now, now);
  const before = f.sqlite.prepare("SELECT * FROM video_transcripts WHERE id='existing-asr'").get();
  assert.equal((await f.retry({ moduleKeys: ["visual"] })).status, 200);
  if (variant === "fresh") f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=? WHERE id=?").run(JSON.stringify(f.checkpoint), f.jobId);
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing',lease_owner='module-worker',lease_expires_at=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), f.jobId);
  const transcript = structuredClone(raw);
  if (variant === "language") transcript.language = "zh";
  if (variant === "fullText") transcript.fullText += "变化";
  if (variant === "segments") transcript.segments[0].end_ms = 999;
  if (variant === "confidence") transcript.confidence = 99;
  const response = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(new Request("http://localhost/complete", { method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" }, body: JSON.stringify({ workerId: "module-worker", resultKey: "module:retry-complete", version: 1, transcript, analysis: { schemaVersion: "analysis.v11", report: unifiedAnalysisReportFixture(), confidence: 80 } }) }), { params: Promise.resolve({ jobId: f.jobId }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).job.status, "completed");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_transcripts").get().n, variant === "same" ? 1 : 2);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM video_transcripts WHERE id='existing-asr'").get(), before);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM video_analyses").get().n, 2, "Both partial and retried reports stay available");
});
