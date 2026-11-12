import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { unifiedAnalysisReportFixture, analysisReportFixture } from "./helpers/content-analysis-fixture.mjs";
const reviewed = JSON.parse(readFileSync(new URL("./fixtures/unified-analysis-v12.json", import.meta.url), "utf8"));

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

test("a completed v12 report keeps successful caches and queues only explicitly pending manuscript IDs", async t => {
  const f = await fixture(t), report = structuredClone(reviewed), checkpoint = structuredClone(f.checkpoint);
  Object.assign(checkpoint.unified_progress, { version: "unified-progress.v2", protocol_version: "unified-analysis.v2", source_signature: report.unified_report.source_signature });
  f.sqlite.prepare("UPDATE analysis_jobs SET status='completed',checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), f.jobId);
  f.saveReport(report, "analysis.v12", "2099-01-01");
  const pending = report.unified_report.canonical.segments.filter(row => row.review_status === "needs_review").map(row => row.source_segment_id);
  const accepted = report.unified_report.canonical.segments.find(row => row.review_status === "accepted").source_segment_id;
  const detail = await f.load("app/api/videos/[videoId]/route.ts").GET(new Request(`http://localhost/detail?organizationId=${f.owner.organizationId}&projectId=${f.projectId}`), { params: Promise.resolve({ videoId: f.videoId }) });
  const body = await detail.json(); assert.equal(detail.status, 200); assert.equal(body.job.module_retry.available, true);
  assert.deepEqual(body.job.module_retry.failedModuleKeys, ["canonical"]); assert.deepEqual(body.job.module_retry.reviewSegmentIds, pending);
  for (const ids of [[accepted], ["transcript:9999"]]) assert.equal((await f.retry({ moduleKeys: ["canonical"], reviewSegmentIds: ids })).status, 409);
  assert.equal((await f.retry({ reviewSegmentIds: [] })).status, 400);
  assert.equal((await f.retry({ moduleKeys: ["visual"], reviewSegmentIds: pending })).status, 400);
  const response = await f.retry({ moduleKeys: ["canonical"], reviewSegmentIds: pending });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  assert.deepEqual(saved.retry_review_segment_ids, pending); assert.deepEqual(saved.retry_module_keys, ["canonical"]);
  assert.deepEqual(saved.unified_progress, checkpoint.unified_progress);
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

async function revalidationFixture(t) {
  const f = await fixture(t), report = unifiedAnalysisReportFixture(), checkpoint = structuredClone(f.checkpoint);
  checkpoint.unified_progress.source_signature = report.unified_report.source_signature;
  checkpoint.unified_progress.modules = Object.fromEntries(report.unified_report.sections.map(section => [section.key, {
    status: "completed", signature: "a".repeat(64), validation: { passed: true, issues: [] }, response: {}, findings: [],
  }]));
  f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), f.jobId);
  f.saveReport(report, "analysis.v11", "2099-01-01");
  return { ...f, checkpoint };
}

for (const explicit of [false, true]) test(`a complete report can be revalidated from successful checkpoints without model targets: ${explicit}`, async t => {
  const f = await revalidationFixture(t), response = await f.retry(explicit ? { revalidateOnly: true } : {});
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.deepEqual(payload.job.moduleKeys, []); assert.equal(payload.job.revalidationOnly, true);
  const job = f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), saved = JSON.parse(job.checkpoint_json);
  assert.equal(job.status, "pending"); assert.equal(job.current_stage, "等待复验已保存的完整报告");
  assert.equal(saved.report_revalidation_only, true); assert.deepEqual(saved.retry_module_keys, []);
  assert.deepEqual(saved.unified_progress, f.checkpoint.unified_progress);
});

for (const variant of ["missing", "invalid", "source"]) test(`report revalidation refuses incomplete or changed checkpoints: ${variant}`, async t => {
  const f = await revalidationFixture(t), checkpoint = structuredClone(f.checkpoint);
  if (variant === "missing") delete checkpoint.unified_progress.modules.visual;
  if (variant === "invalid") checkpoint.unified_progress.modules.visual.validation.passed = false;
  if (variant === "source") checkpoint.unified_progress.source_signature = "b".repeat(64);
  f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), f.jobId);
  const response = await f.retry({ revalidateOnly: true });
  assert.equal(response.status, 409);
  assert.equal(f.sqlite.prepare("SELECT status FROM analysis_jobs WHERE id=?").get(f.jobId).status, "partial");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='analysis_job.retried'").get().n, 0);
});

test("report revalidation cannot be mixed with model or manuscript repair", async t => {
  const f = await revalidationFixture(t);
  assert.equal((await f.retry({ revalidateOnly: "true" })).status, 400);
  assert.equal((await f.retry({ revalidateOnly: true, moduleKeys: ["visual"] })).status, 400);
});

test("healthy completed reports do not expose a new recovery action", async t => {
  const f = await revalidationFixture(t);
  const state = f.load("lib/analysis-module-retry.ts").readAnalysisModuleRetryState(
    JSON.stringify(f.checkpoint), "analysis.v11", unifiedAnalysisReportFixture(), "completed");
  assert.equal(state.available, false); assert.equal(state.reportRevalidationAvailable, false);
});

for (const mode of ["module", "script", "segment"]) test(`a later ${mode} repair clears a previous revalidation-only intent`, async t => {
  const f = await fixture(t), checkpoint = structuredClone(f.checkpoint), key = "c".repeat(64);
  checkpoint.report_revalidation_only = true;
  checkpoint.previous_spoken_script_set = { light_rewrite: { status: "failed" } };
  checkpoint.segment_progress = { segments: [{ window_key: key, index: 0, start_ms: 0, end_ms: 1000, status: "failed" }] };
  f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=?,checkpoint_stage=? WHERE id=?")
    .run(JSON.stringify(checkpoint), mode === "segment" ? "segment_progress" : "evidence_ready", f.jobId);
  const payload = mode === "module" ? { moduleKeys: ["visual"] } : mode === "script" ? { scriptVersion: "light_rewrite" } : { segmentKey: key };
  const response = await f.retry(payload);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  assert.equal(saved.report_revalidation_only, undefined);
});

test("finalizing a report revalidation clears its one-attempt intent while preserving pending manuscript review", async t => {
  const f = await fixture(t), report = structuredClone(reviewed), checkpoint = structuredClone(f.checkpoint);
  Object.assign(checkpoint.unified_progress, { version: "unified-progress.v2", protocol_version: "unified-analysis.v2", source_signature: report.unified_report.source_signature });
  checkpoint.unified_progress.modules = Object.fromEntries(report.unified_report.sections.map(section => [section.key, {
    status: "completed", signature: "a".repeat(64), validation: { passed: true, issues: [] }, response: {}, findings: [],
  }]));
  f.sqlite.prepare("UPDATE analysis_jobs SET checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), f.jobId);
  f.saveReport(report, "analysis.v12", "2099-01-01");
  const retried = await f.retry({ revalidateOnly: true });
  assert.equal(retried.status, 200, await retried.clone().text());
  f.sqlite.prepare("UPDATE analysis_jobs SET status='analyzing',lease_owner='module-worker',lease_expires_at=? WHERE id=?")
    .run(new Date(Date.now() + 60_000).toISOString(), f.jobId);
  const response = await f.load("app/api/internal/analysis-jobs/[jobId]/complete/route.ts").POST(new Request("http://localhost/complete", {
    method: "POST", headers: { authorization: "Bearer synthetic-service-token", "content-type": "application/json" },
    body: JSON.stringify({ workerId: "module-worker", resultKey: "report:revalidated", version: 1,
      analysis: { schemaVersion: "analysis.v12", report, confidence: 80 } }),
  }), { params: Promise.resolve({ jobId: f.jobId }) });
  assert.equal(response.status, 200, await response.clone().text());
  const job = f.sqlite.prepare("SELECT * FROM analysis_jobs WHERE id=?").get(f.jobId), saved = JSON.parse(job.checkpoint_json);
  assert.equal(job.status, "completed"); assert.equal(saved.report_revalidation_only, undefined);
  assert.deepEqual(saved.unified_progress, checkpoint.unified_progress);
  assert.equal((await f.retry({ moduleKeys: ["canonical"] })).status, 200);
});

async function allPendingWithOcrFixture(t) {
  const f = await fixture(t), report = structuredClone(reviewed), content = report.content_analysis, unified = report.unified_report;
  const textKeys = ["text_topic_structure_audience", "text_expression_value"], signature = unified.source_signature;
  for (const segment of unified.canonical.segments) Object.assign(segment, {
    text: segment.original_text, review_status: "needs_review", candidate_text: null, issues: ["model_declared_uncertain"], evidence_ids: [],
  });
  unified.canonical.status = "needs_review"; unified.canonical.validation = { passed: false, issues: ["speech_requires_review"] };
  const ids = unified.canonical.segments.map(row => row.source_segment_id);
  content.methodology.transcript_review = { total_segments: ids.length, accepted_segments: 0, uncertain_segment_ids: ids,
    uncertain_ranges: unified.canonical.segments.map(({ source_segment_id, start_ms, end_ms }) => ({ source_segment_id, start_ms, end_ms })), first_source_segment_id: ids[0] };
  content.evidence_registry = content.evidence_registry.filter(row => row.source !== "transcript");
  for (const row of content.classifications) if (row.dimension_id.startsWith("synthesis.") || row.evidence_ids.some(id => id.startsWith("transcript:"))) Object.assign(row, {
    state: "unknown", tags: null, primary_tag: null, reason: "trusted_text_not_acquired", evidence_ids: [],
  });
  content.segments = []; content.information_units = [];
  const visual = content.evidence_registry.find(row => row.source === "vision");
  for (const key of textKeys) {
    Object.assign(content.module_status[key], { status: "not_acquired", reason: "required_evidence_not_acquired", validation: { passed: true, issues: [] }, source_coverage: null });
    Object.assign(unified.sections.find(row => row.key === key), { status: "not_acquired", reason: "required_evidence_not_acquired", findings: [] });
  }
  unified.sections.find(row => row.key === "synthesis").findings = [{ id: "synthetic-visual-summary", title: "核心结论", text: "画面展示合成会议待办示意。", evidence_ids: [visual.id] }];
  unified.summary = "画面展示合成会议待办示意。";
  const issues = textKeys.map(key => `${key}:not_acquired`);
  content.status = unified.status = "partial"; content.validation = unified.validation = { passed: false, issues };
  Object.assign(unified.outcome, { report: "partial", manuscript: "needs_review", review_segment_count: ids.length });
  const metrics = content.metrics.media;
  const frames = content.evidence_registry.filter(row => row.source === "frame").map((row, index) => ({
    timestamp_ms: row.start_ms, asset_id: row.asset_ref, ocr_text: content.evidence_registry.find(item => item.id === `ocr:${String(index + 1).padStart(4, "0")}`)?.text ?? null,
  }));
  const observations = [];
  for (const row of content.evidence_registry.filter(row => row.source === "vision")) observations[Number(row.id.split(":")[1]) - 1] = { kind: "vision", start_ms: row.start_ms, end_ms: row.end_ms, text: row.text };
  const modules = Object.fromEntries(["visual", "synthesis"].map(key => [key, { status: "completed", signature: "a".repeat(64), validation: { passed: true, issues: [] }, response: {}, findings: unified.sections.find(row => row.key === key).findings }]));
  const checkpoint = { checkpoint_version: 1,
    media: { duration_ms: metrics.duration_ms, width: metrics.encoded_width, height: metrics.encoded_height, video_codec: "h264", audio_codec: "aac" },
    transcript: { language: "zh", segments: unified.canonical.segments.map(({ start_ms, end_ms, original_text }) => ({ start_ms, end_ms, text: original_text })) },
    visuals: { keyframes: frames, observations: observations.map(row => row ?? { kind: "ocr" }), stats: { evidence_version: "visual-evidence.v2" } },
    unified_progress: { version: "unified-progress.v2", protocol_version: "unified-analysis.v2", source_signature: signature,
      canonical: { ...structuredClone(unified.canonical), source_hash: "c".repeat(64) }, modules } };
  const install = () => {
    f.sqlite.prepare("UPDATE analysis_jobs SET status='partial',checkpoint_json=? WHERE id=?").run(JSON.stringify(checkpoint), f.jobId);
    f.saveReport(report, "analysis.v12", "2099-01-01");
  };
  install();
  return { ...f, report, checkpoint, install, textKeys };
}

for (const explicit of [false, true]) test(`all pending speech with matching OCR recovers only incomplete text modules: ${explicit}`, async t => {
  const f = await allPendingWithOcrFixture(t), before = structuredClone(f.checkpoint);
  const state = f.load("lib/analysis-module-retry.ts").readAnalysisModuleRetryState(JSON.stringify(f.checkpoint), "analysis.v12", f.report, "partial");
  assert.deepEqual(state?.recoverableTextModuleKeys, f.textKeys);
  const response = await f.retry(explicit ? { moduleKeys: f.textKeys } : {});
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(); assert.deepEqual(body.job.moduleKeys, f.textKeys); assert.equal(body.job.reviewSegmentIds, null);
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  assert.deepEqual(saved.unified_progress, before.unified_progress);
  assert.deepEqual(saved.media, before.media); assert.deepEqual(saved.visuals, before.visuals); assert.deepEqual(saved.transcript, before.transcript);
  assert.deepEqual(saved.retry_module_keys, f.textKeys); assert.equal(saved.retry_review_segment_ids, null);
});

test("explicit canonical review remains available instead of the OCR default", async t => {
  const f = await allPendingWithOcrFixture(t), response = await f.retry({ moduleKeys: ["canonical"] });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json(); assert.deepEqual(body.job.moduleKeys, ["canonical"]);
  assert.deepEqual(body.job.reviewSegmentIds, f.report.unified_report.canonical.segments.map(row => row.source_segment_id));
});

for (const variant of ["no-ocr", "changed-media", "changed-asr", "changed-ocr", "changed-vision", "source-signature", "missing-canonical", "missing-visual-cache", "other-missing-reason", "visual-not-acquired"]) test(`OCR text recovery rejects unavailable or mismatched proof: ${variant}`, async t => {
  const f = await allPendingWithOcrFixture(t), cp = f.checkpoint, content = f.report.content_analysis;
  if (variant === "no-ocr") { for (const frame of cp.visuals.keyframes) frame.ocr_text = null; content.evidence_registry = content.evidence_registry.filter(row => row.source !== "ocr"); }
  if (variant === "changed-media") cp.media.duration_ms += 1;
  if (variant === "changed-asr") cp.transcript.segments[0].text += "来源变化";
  if (variant === "changed-ocr") cp.visuals.keyframes.find(row => row.ocr_text).ocr_text += "来源变化";
  if (variant === "changed-vision") cp.visuals.observations.find(row => row.kind === "vision").text += "来源变化";
  if (variant === "source-signature") cp.unified_progress.source_signature = "b".repeat(64);
  if (variant === "missing-canonical") delete cp.unified_progress.canonical;
  if (variant === "missing-visual-cache") delete cp.unified_progress.modules.visual;
  if (variant === "other-missing-reason") for (const key of f.textKeys) {
    content.module_status[key].reason = "not_requested";
    f.report.unified_report.sections.find(row => row.key === key).reason = "not_requested";
  }
  if (variant === "visual-not-acquired") {
    Object.assign(content.module_status.visual, { status: "not_acquired", reason: "required_evidence_not_acquired" });
    Object.assign(f.report.unified_report.sections[2], { status: "not_acquired", reason: "required_evidence_not_acquired", findings: [] });
  }
  f.install();
  const response = await f.retry({ moduleKeys: variant === "visual-not-acquired" ? ["visual"] : f.textKeys });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(f.sqlite.prepare("SELECT status FROM analysis_jobs WHERE id=?").get(f.jobId).status, "partial");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='analysis_job.retried'").get().n, 0);
});

test("successful visual and synthesis modules stay nonretryable during OCR recovery", async t => {
  const f = await allPendingWithOcrFixture(t);
  for (const key of ["visual", "synthesis"]) {
    const response = await f.retry({ moduleKeys: [key] });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "MODULE_NOT_FAILED");
  }
});

test("independent OCR text remains recoverable without visual understanding when existing synthesis is reusable", async t => {
  const f = await allPendingWithOcrFixture(t), content = f.report.content_analysis;
  content.evidence_registry = content.evidence_registry.filter(row => !["vision", "temporal"].includes(row.source));
  for (const row of content.classifications) Object.assign(row, { state: "unknown", tags: null, primary_tag: null, reason: "material_not_acquired", evidence_ids: [] });
  const ocr = content.evidence_registry.find(row => row.source === "ocr");
  f.report.unified_report.sections.find(row => row.key === "synthesis").findings[0].evidence_ids = [ocr.id];
  Object.assign(content.module_status.visual, { status: "not_acquired", reason: "required_evidence_not_acquired", validation: { passed: true, issues: [] }, source_coverage: null });
  Object.assign(f.report.unified_report.sections[2], { status: "not_acquired", reason: "required_evidence_not_acquired", findings: [] });
  f.checkpoint.visuals.observations = []; delete f.checkpoint.unified_progress.modules.visual;
  f.install();
  const response = await f.retry();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).job.moduleKeys, f.textKeys);
  const saved = JSON.parse(f.sqlite.prepare("SELECT checkpoint_json FROM analysis_jobs WHERE id=?").get(f.jobId).checkpoint_json);
  assert.deepEqual(saved.retry_module_keys, f.textKeys);
  assert.equal(saved.unified_progress.modules.visual, undefined);
  assert.deepEqual(saved.unified_progress.modules.synthesis, f.checkpoint.unified_progress.modules.synthesis);
});
