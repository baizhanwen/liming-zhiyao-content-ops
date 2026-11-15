import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const created = "2026-01-01T00:00:00.000Z";
const reportAt = "2026-01-01T00:05:00.000Z";
const later = "2026-01-01T00:10:00.000Z";

function measuredReport(overrides = {}) {
  return {
    summary: "Historical report: visible user content stays intact",
    analysis_meta: {
      evidence_reused: false,
      visual_extraction: {
        candidate_count: 54, kept_count: 30,
        stage_timing: { frame_extraction_elapsed_ms: 1010, frame_filter_elapsed_ms: 20,
          ocr_elapsed_ms: 3000, vision_elapsed_ms: 5000, ocr_vision_wall_ms: 6000, ocr_vision_overlap_ms: 2000, mode: "overlapped" },
        branch_timing: { transcription_elapsed_ms: 7000, visual_elapsed_ms: 7030 },
        visual_understanding: { batches: [{ index: 1, attempt: 1, elapsed_ms: 5000, status: "completed" }] },
      },
      model_requests: [{ task: "canonical_review", attempt: 1, elapsed_ms: 120, input_tokens: 10 }],
    },
    unified_report: { timing: { elapsed_ms: 1000, canonical_elapsed_ms: 200, modules_elapsed_ms: 800 }, sections: [
      { key: "text", status: "completed", diagnostics: { attempts: 2, elapsed_ms: 600, reused: false } },
      { key: "visual", status: "completed", diagnostics: { attempts: 0, elapsed_ms: 0, reused: true } },
      { key: "synthesis", status: "failed", diagnostics: { attempts: 0, elapsed_ms: 0, reused: false } },
      { key: "cached_nonzero", status: "completed", diagnostics: { attempts: 2, elapsed_ms: 777, reused: true } },
    ] },
    ...overrides,
  };
}

async function fixture(t, { withReport = true, report = measuredReport(), bound = true, status = "failed" } = {}) {
  const f = runtimeFixture(t), owner = await f.initialize();
  f.identity.userId = owner.userId;
  const projectId = crypto.randomUUID(), videoId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const latestJobId = crypto.randomUUID(), analysisId = crypto.randomUUID(), latestAnalysisId = crypto.randomUUID();
  let authenticated = true, allowed = true;
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => authenticated ? { authSubject: owner.userId } : null });
  f.runtime.getProjectAccess = async (_subject, organization, project) => allowed && organization === owner.organizationId && project === projectId
    ? { organizationRole: "admin", projectRole: "member" } : null;
  f.runtime.getOrganizationAccess = async (_subject, organization) => organization === owner.organizationId ? { organizationRole: "admin", userId: owner.userId } : null;
  f.runtime.canAccessOrganizationVideoLibrary = async () => false;
  f.runtime.canWriteProjectAccess = () => true;
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Diagnostic export','Synthetic',?,?,?,?)")
    .run(projectId, owner.organizationId, owner.userId, owner.userId, created, created);
  f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,source_url,title,duration_sec,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,'Export / diagnostic: fixture',600,'ready',?,?,?,?)")
    .run(videoId, owner.organizationId, projectId, "https://example.invalid/source?token=SOURCE_URL_SECRET", owner.userId, owner.userId, created, created);
  const addJob = (id, when, state = "failed") => f.sqlite.prepare(`INSERT INTO analysis_jobs(id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,progress,
      attempt_count,retry_count,resume_count,result_key,checkpoint_json,error_message,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,'url','PRIVATE_SOURCE_REF',?,?,50,3,2,1,'RESULT_KEY_SECRET',?, ?,?,?,?,?)`)
    .run(id, owner.organizationId, projectId, videoId, `diagnostic:${id}`, state,
      JSON.stringify({ api_key: "CHECKPOINT_SECRET" }), "Synthetic error Bearer JOB_ERROR_SECRET api_key=JOB_ASSIGNED_SECRET", owner.userId, owner.userId, when, later);
  addJob(jobId, created, status);
  if (withReport) addJob(latestJobId, later);
  const addAnalysis = (id, boundJobId, when, value, schema = "analysis.v12") => f.sqlite.prepare(`INSERT INTO video_analyses
    (id,organization_id,project_id,video_id,analysis_job_id,schema_version,report_json,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, owner.organizationId, projectId, videoId, boundJobId, schema, JSON.stringify(value), owner.userId, when, when);
  if (withReport) {
    addAnalysis(analysisId, bound ? jobId : null, reportAt, report);
    addAnalysis(latestAnalysisId, latestJobId, later, { summary: "LATEST_REPORT_MUST_NOT_REPLACE_HISTORY" });
  }
  const addEvent = (id, eventJobId, when, details = {}, eventType = "heartbeat") => f.sqlite.prepare(`INSERT INTO analysis_job_events
    (id,organization_id,project_id,job_id,video_id,event_type,from_status,to_status,progress,details_json,created_at)
    VALUES(?,?,?,?,?,?,'transcribing','transcribing',50,?,?)`).run(id, owner.organizationId, projectId, eventJobId, videoId, eventType, JSON.stringify(details), when);
  addEvent("selected-claim", jobId, "2026-01-01T00:01:00.000Z", { attempt: 1, checkpointStage: null }, "claimed");
  addEvent("selected-terminal", jobId, reportAt, { schemaVersion: "analysis.v12" }, "partial");
  addEvent("late-retry", jobId, later, { attempt: 2, message: "LATE_RETRY_MUST_NOT_APPEAR" }, "claimed");
  if (withReport) addEvent("different-job", latestJobId, "2026-01-01T00:02:00.000Z", { message: "OTHER_JOB_MUST_NOT_APPEAR" });
  const exportJson = async ({ selected = withReport ? analysisId : null, video = videoId, organization = owner.organizationId } = {}) => {
    const query = new URLSearchParams({ organizationId: organization, projectId, export: "json", ...(selected ? { analysisId: selected } : {}) });
    const before = f.sqlite.prepare("SELECT total_changes() AS count").get().count;
    f.sqlite.exec("PRAGMA query_only=ON");
    const response = await f.load("app/api/videos/[videoId]/route.ts").GET(new Request(`http://localhost/api/videos/${video}?${query}`), { params: Promise.resolve({ videoId: video }) });
    assert.equal(f.sqlite.prepare("SELECT total_changes() AS count").get().count, before, "Diagnostic GET must not write SQLite");
    return { response, body: await response.json() };
  };
  return { ...f, owner, projectId, videoId, jobId, latestJobId, analysisId, latestAnalysisId, report, addAnalysis, addEvent, exportJson,
    authenticate: value => { authenticated = value; }, allow: value => { allowed = value; } };
}

test("historical JSON download binds the selected report, original job and events through report creation", async t => {
  const f = await fixture(t), { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json.*charset=utf-8/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /^attachment;.*filename\*=UTF-8''/);
  assert.equal(body.schemaVersion, "analysis-report-export.v1");
  assert.equal(body.selection.analysisId, f.analysisId);
  assert.equal(body.selection.jobId, f.jobId);
  assert.equal(body.selection.reportCreatedAt, reportAt);
  assert.deepEqual(body.report, f.report);
  assert.equal(body.diagnostics.jobSnapshot.id, f.jobId);
  assert.equal(body.diagnostics.latestJobSnapshot.id, f.latestJobId);
  assert.equal(body.diagnostics.events.through, reportAt);
  assert.deepEqual(body.diagnostics.events.items.map(row => row.id), ["selected-claim", "selected-terminal"]);
  assert.ok(body.diagnostics.events.items.every(row => row.job_id === f.jobId));
  assert.equal(body.diagnostics.events.totalCount, 2);
  assert.equal(body.diagnostics.events.truncated, false);
});

test("raw visual timing survives export while normalized timings preserve measured units and overlap", async t => {
  const f = await fixture(t), { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.deepEqual(body.diagnostics.visual.stage_timing, f.report.analysis_meta.visual_extraction.stage_timing);
  assert.deepEqual(body.diagnostics.visual.branch_timing, f.report.analysis_meta.visual_extraction.branch_timing);
  const timings = Object.fromEntries(body.diagnostics.timings.map(row => [row.key, row]));
  assert.equal(body.diagnostics.timingUnit, "milliseconds");
  assert.equal(timings.frame_extraction.elapsedMs, 1010);
  assert.equal(timings.ocr.elapsedMs, 3000);
  assert.equal(timings.vision.elapsedMs, 5000);
  assert.equal(timings.ocr_vision_wall.elapsedMs, 6000);
  assert.equal(timings.ocr_vision_overlap.elapsedMs, 2000);
  assert.equal(timings.ocr_vision_overlap.basis, "overlap");
  assert.equal(timings.transcript_preparation.elapsedMs, 7000);
  assert.match(timings.transcript_preparation.label, /不等同于纯转写/);
  assert.equal(timings.report_generation.scope, "report_execution");
  assert.equal(timings.report_generation.elapsedMs, 1000);
  assert.equal(timings.source_download.elapsedMs, null);
  assert.equal(timings.artifact_persistence.elapsedMs, null);
  assert.ok(body.diagnostics.notes.some(note => /不包含.*GPU/.test(note)));
});

test("pure-vision export retains skipped OCR, measured zero work and visual-model text provenance", async t => {
  const report = measuredReport();
  report.analysis_meta.visual_analysis_mode = "vision_only";
  Object.assign(report.analysis_meta.visual_extraction, {
    visual_analysis_mode: "vision_only", screen_text_source: "vision_model",
    ocr: { status: "skipped", reason: "vision_only" },
    ocr_engine_call_count: 0, ocr_exact_reuse_count: 0,
    ocr_observation_count: 0,
  });
  Object.assign(report.analysis_meta.visual_extraction.stage_timing, {
    ocr_elapsed_ms: 0, ocr_vision_wall_ms: 5000, ocr_vision_overlap_ms: 0,
  });
  const f = await fixture(t, { report });
  f.sqlite.prepare("UPDATE analysis_jobs SET visual_analysis_mode='vision_only' WHERE id=?").run(f.jobId);
  const { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.equal(body.diagnostics.visualAnalysisMode, "vision_only");
  assert.equal(body.diagnostics.jobSnapshot.visual_analysis_mode, "vision_only");
  assert.equal(body.diagnostics.visual.visual_analysis_mode, "vision_only");
  assert.equal(body.diagnostics.visual.screen_text_source, "vision_model");
  assert.equal(body.diagnostics.visual.ocr.status, "skipped");
  assert.equal(body.diagnostics.visual.ocr_engine_call_count, 0);
  assert.equal(body.diagnostics.visual.ocr_exact_reuse_count, 0);
  assert.equal(body.diagnostics.timings.find(row => row.key === "ocr").elapsedMs, 0);
  assert.equal(body.diagnostics.timings.find(row => row.key === "vision").elapsedMs, 5000);
  assert.equal(body.diagnostics.timings.find(row => row.key === "ocr_vision_overlap").elapsedMs, 0);
  assert.deepEqual(body.report, report, "Export must preserve the selected report's recorded mode and provenance");
});

test("selected report mode wins over extraction metadata and the newer job's different mode", async t => {
  const report = measuredReport();
  report.analysis_meta.visual_analysis_mode = "hybrid";
  report.analysis_meta.visual_extraction.visual_analysis_mode = "vision_only";
  const f = await fixture(t, { report });
  f.sqlite.prepare("UPDATE analysis_jobs SET visual_analysis_mode='vision_only' WHERE id=?").run(f.latestJobId);
  const { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.equal(body.selection.analysisId, f.analysisId);
  assert.equal(body.diagnostics.visualAnalysisMode, "hybrid");
  assert.equal(body.diagnostics.jobSnapshot.visual_analysis_mode, "hybrid");
  assert.equal(body.diagnostics.latestJobSnapshot.visual_analysis_mode, "vision_only");
  assert.equal(body.diagnostics.visual.stage_timing.ocr_elapsed_ms, 3000);
});

test("imported report mode can come from saved visual statistics without borrowing any job", async t => {
  const report = measuredReport();
  report.analysis_meta.visual_extraction.visual_analysis_mode = "vision_only";
  report.analysis_meta.visual_extraction.screen_text_source = "vision_model";
  const f = await fixture(t, { report, bound: false });
  f.sqlite.prepare("UPDATE analysis_jobs SET visual_analysis_mode='hybrid' WHERE id=?").run(f.latestJobId);
  const { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.equal(body.selection.jobId, null);
  assert.equal(body.diagnostics.jobSnapshot, null);
  assert.equal(body.diagnostics.visualAnalysisMode, "vision_only");
  assert.equal(body.diagnostics.visual.screen_text_source, "vision_model");
});

test("before a report exists diagnostic mode comes from the current job snapshot", async t => {
  for (const visualAnalysisMode of ["hybrid", "vision_only"]) {
    const f = await fixture(t, { withReport: false, status: "failed" });
    f.sqlite.prepare("UPDATE analysis_jobs SET visual_analysis_mode=? WHERE id=?").run(visualAnalysisMode, f.jobId);
    const { response, body } = await f.exportJson();
    assert.equal(response.status, 200);
    assert.equal(body.report, null);
    assert.equal(body.analysis, null);
    assert.equal(body.diagnostics.visualAnalysisMode, visualAnalysisMode);
    assert.equal(body.diagnostics.jobSnapshot.visual_analysis_mode, visualAnalysisMode);
  }
});

test("JSON downloads retain a complete emoji at a long Chinese filename boundary", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE videos SET title=? WHERE id=?").run("字".repeat(79) + "😀/后续标题", f.videoId);
  const { response } = await f.exportJson();
  assert.equal(response.status, 200);
  const filename = decodeURIComponent(response.headers.get("content-disposition").split("filename*=UTF-8''")[1]);
  assert.ok(filename.includes("😀"));
  assert.ok(filename.endsWith(".json"));
  assert.ok(!/[\\/:*?"<>|]/.test(filename));
});

test("reused evidence timing remains historical evidence, never new report execution", async t => {
  const report = measuredReport();
  report.analysis_meta.evidence_reused = true;
  const f = await fixture(t, { report }), { body } = await f.exportJson();
  assert.equal(body.diagnostics.evidenceReused, true);
  for (const key of ["frame_extraction", "ocr", "vision", "visual_pipeline", "transcript_preparation"]) {
    assert.equal(body.diagnostics.timings.find(row => row.key === key).scope, "reused_evidence");
  }
  assert.equal(body.diagnostics.timings.find(row => row.key === "report_generation").scope, "report_execution");
  assert.equal(body.diagnostics.visual.stage_timing.ocr_elapsed_ms, 3000);
});

test("zero-attempt and reused module diagnostics do not invent zero-millisecond new work", async t => {
  const f = await fixture(t), { body } = await f.exportJson();
  const modules = Object.fromEntries(body.diagnostics.modules.map(row => [row.key, row]));
  assert.equal(modules.text.elapsedMs, 600);
  assert.equal(modules.text.basis, "request_sum");
  assert.equal(modules.visual.reused, true);
  assert.equal(modules.visual.elapsedMs, null);
  assert.equal(modules.synthesis.elapsedMs, null);
  assert.equal(modules.cached_nonzero.elapsedMs, null, "A reused result's old nonzero duration is not a new request");
  assert.equal(modules.visual.diagnostics.elapsed_ms, 0, "Raw report diagnostics remain available for traceability");
});

test("older reports export absent timings as null rather than invented zeros", async t => {
  const f = await fixture(t, { report: { summary: "Old report without timing" } }), { body } = await f.exportJson();
  assert.equal(body.report.summary, "Old report without timing");
  assert.equal(body.diagnostics.evidenceReused, null);
  assert.ok(body.diagnostics.timings.length > 0 && body.diagnostics.timings.every(row => row.elapsedMs === null));
  assert.deepEqual(body.diagnostics.modules, []);
});

test("running and failed jobs can export diagnostics before any report exists", async t => {
  for (const status of ["transcribing", "failed"]) {
    const f = await fixture(t, { withReport: false, status }), { response, body } = await f.exportJson();
    assert.equal(response.status, 200);
    assert.equal(body.analysis, null);
    assert.equal(body.report, null);
    assert.equal(body.selection.analysisId, null);
    assert.equal(body.selection.jobId, f.jobId);
    assert.equal(body.diagnostics.jobSnapshot.status, status);
    assert.equal(body.diagnostics.events.scope, "job_lifecycle_as_of_export");
    assert.equal(body.diagnostics.events.totalCount, 3);
  }
});

test("imported historical reports with no job never borrow the latest job or its events", async t => {
  const f = await fixture(t, { bound: false }), { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.equal(body.selection.analysisId, f.analysisId);
  assert.equal(body.selection.jobId, null);
  assert.equal(body.diagnostics.jobSnapshot, null);
  assert.equal(body.diagnostics.events.jobId, null);
  assert.equal(body.diagnostics.events.available, false);
  assert.deepEqual(body.diagnostics.events.items, []);
});

test("diagnostic secrets are redacted without changing ordinary report prose", async t => {
  const report = measuredReport({ summary: "Keep the user's report wording" });
  report.credentials = { api_key: "REPORT_KEY_SECRET", authorization: "REPORT_AUTH_SECRET", headers: { cookie: "COOKIE_SECRET" } };
  report.analysis_meta.visual_extraction.ocr_errors = [{ message: "RuntimeError Bearer DIAGNOSTIC_BEARER_SECRET api_key=ERROR_ASSIGNED_SECRET token=BARE_TOKEN_SECRET proxy https://proxy-user:PROXY_PASSWORD_SECRET@proxy.invalid" }];
  const f = await fixture(t, { report });
  f.addEvent("secret-event", f.jobId, "2026-01-01T00:03:00.000Z", { apiKey: "EVENT_KEY_SECRET", analyzer_service_token: "EVENT_SERVICE_SECRET", reason: "Bearer EVENT_BEARER_SECRET" });
  const { response, body } = await f.exportJson();
  assert.equal(response.status, 200);
  assert.equal(body.report.summary, report.summary);
  const serialized = JSON.stringify(body);
  for (const secret of ["REPORT_KEY_SECRET", "REPORT_AUTH_SECRET", "COOKIE_SECRET", "DIAGNOSTIC_BEARER_SECRET", "ERROR_ASSIGNED_SECRET",
    "EVENT_KEY_SECRET", "EVENT_SERVICE_SECRET", "EVENT_BEARER_SECRET", "CHECKPOINT_SECRET", "RESULT_KEY_SECRET", "SOURCE_URL_SECRET", "JOB_ERROR_SECRET", "JOB_ASSIGNED_SECRET", "BARE_TOKEN_SECRET", "PROXY_PASSWORD_SECRET"]) {
    assert.ok(!serialized.includes(secret), `Export leaked ${secret}`);
  }
  assert.match(serialized, /REDACTED/);
});

test("export enforces authentication, project access and tenant-scoped report selection", async t => {
  const unauthenticated = await fixture(t);
  unauthenticated.authenticate(false);
  assert.equal((await unauthenticated.exportJson()).response.status, 401);
  const denied = await fixture(t);
  denied.allow(false);
  assert.equal((await denied.exportJson()).response.status, 403);
  const scoped = await fixture(t), other = { organizationId: crypto.randomUUID(), userId: scoped.owner.userId };
  scoped.sqlite.prepare("INSERT INTO organizations(id,name,slug,status,created_by,created_at,updated_at) VALUES(?,'Foreign organization',?,'active',?,?,?)")
    .run(other.organizationId, `foreign-${other.organizationId}`, other.userId, created, created);
  const foreignProject = crypto.randomUUID(), foreignVideo = crypto.randomUUID(), foreignAnalysis = crypto.randomUUID();
  scoped.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,'Foreign','Synthetic',?,?,?,?)")
    .run(foreignProject, other.organizationId, other.userId, other.userId, created, created);
  scoped.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'douyin','url',?,?,?,?)")
    .run(foreignVideo, other.organizationId, foreignProject, other.userId, other.userId, created, created);
  scoped.sqlite.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES(?,?,?,?,'analysis.v12','{}',?,?,?)")
    .run(foreignAnalysis, other.organizationId, foreignProject, foreignVideo, other.userId, created, created);
  assert.equal((await scoped.exportJson({ selected: foreignAnalysis })).response.status, 404);
  assert.equal((await scoped.exportJson({ video: foreignVideo, selected: null })).response.status, 404);
});
