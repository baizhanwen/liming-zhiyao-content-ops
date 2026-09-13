import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { resolveVideoSubmission, newVideoSubmissionStatements } from "../lib/video-submission.ts";
import { readBenchmarkFeedback, materialFeedbackFromRow } from "../lib/benchmark-feedback.ts";
import { extractResponseText } from "../lib/model-response.ts";
import { readApiError, formatClientDate } from "../lib/client-format.ts";
import { isActiveAnalysisStatus, isLeasedAnalysisStatus, ACTIVE_ANALYSIS_STATUSES_SQL, LEASED_ANALYSIS_STATUSES_SQL } from "../lib/analysis-jobs.ts";
import { resetClientScope, runScopedAction, scopedFetch } from "../lib/client-scope-request.ts";

async function fixture(t) {
  const f = runtimeFixture(t), installation = await f.initialize();
  f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, now = "2026-09-10T00:00:00.000Z";
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: "source", created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  for (const id of ["source", "target"]) seed("projects", { id, name: id, client_name: id });
  const input = { organizationId, projectId: "source", userId: installation.userId, now, sourceType: "url", sourceHash: "url-hash", sourceUrl: "https://www.douyin.com/video/1234567890" };
  const createVideo = async (override = {}) => {
    const submission = { ...input, videoId: crypto.randomUUID(), jobId: crypto.randomUUID(), title: "Synthetic test video", analysisProfile: "full", auditMetadata: {}, ...override };
    await f.db.batch(newVideoSubmissionStatements(f.db, submission));
    return submission;
  };
  return { ...f, seed, input, createVideo, organizationId, now };
}

test("existing uploads remain reusable while analyzer is offline, and new uploads still fail preflight", async t => {
  const f = await fixture(t), bytes = Buffer.from("synthetic media, never decoded"), hash = createHash("sha256").update(bytes).digest("hex");
  const mediaAssetId = f.seed("media_assets", { kind: "source_video", r2_key: "test/source", filename: "test.mp4", content_type: "video/mp4", size_bytes: bytes.length, sha256: hash });
  const existing = await f.createVideo({ sourceType: "upload", sourceUrl: undefined, sourceHash: hash, mediaAssetId });
  let preflights = 0, writes = 0;
  f.mock("lib/analysis-submission-availability.ts", { checkNewAnalysisAvailability: async () => { preflights++; return Response.json({ error: { code: "ANALYZER_OFFLINE" } }, { status: 503 }); } });
  f.runtime.getProjectAccess = async (_subject, org, project) => org === f.organizationId && ["source", "target"].includes(project) ? { allowed: true } : null;
  f.runtime.canWriteProjectAccess = access => access.allowed;
  f.runtime.getMediaBucket = () => ({ put: async () => { writes++; }, delete: async () => {} });
  const route = f.load("app/api/videos/upload/route.ts");
  const request = (projectId, payload = bytes) => {
    const form = new FormData(); form.set("file", new File([payload], "test.mp4", { type: "video/mp4" }));
    return new Request("http://localhost/api/videos/upload", { method: "POST", headers: { "x-organization-id": f.organizationId, "x-project-id": projectId }, body: form });
  };
  const reused = await route.POST(request("target"));
  assert.equal(reused.status, 200); assert.equal((await reused.json()).video.id, existing.videoId);
  assert.equal(preflights, 0); assert.equal(writes, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_jobs").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM project_video_references WHERE project_id = 'target' AND purpose = 'analysis'").get().n, 1);
  assert.equal((await route.POST(request("source"))).status, 409);
  assert.equal(preflights, 0);
  assert.equal((await route.POST(request("target", Buffer.from("new media")))).status, 503);
  assert.equal(preflights, 1); assert.equal(writes, 0);
  assert.equal((await route.POST(request("inaccessible"))).status, 403);
});

test("URL reuse retains source identity, reactivates references and never crosses organizations", async t => {
  const f = await fixture(t), existing = await f.createVideo();
  let checked = 0;
  const validate = async () => { checked++; return Response.json({}, { status: 503 }); };
  const input = { ...f.input, projectId: "target" };
  const first = await resolveVideoSubmission(f.db, input, validate);
  assert.equal((await first.json()).video.id, existing.videoId);
  f.sqlite.exec("UPDATE project_video_references SET status = 'revoked'");
  const again = await resolveVideoSubmission(f.db, input, validate);
  assert.equal((await again.json()).referenceAction, "reactivated");
  assert.equal(checked, 0);
  assert.equal((await resolveVideoSubmission(f.db, { ...input, organizationId: "other-company" }, validate)).status, 503);
  assert.equal(checked, 1);
});

test("video, library, job and audit creation roll back together", async t => {
  const f = await fixture(t);
  f.sqlite.exec("CREATE TRIGGER injected_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action = 'video.url_submitted' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await assert.rejects(f.createVideo(), /injected failure/);
  for (const table of ["videos", "video_library_entries", "analysis_jobs"]) assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
});

test("recommendation and selected-generation feedback agree without counting versions or metric history twice", async t => {
  const f = await fixture(t), video = await f.createVideo();
  const entry = f.sqlite.prepare("SELECT id FROM video_library_entries WHERE source_video_id = ?").get(video.videoId).id;
  const topic = f.seed("topic_ideas", { title: "Test topic", source_type: "manual" });
  const content = f.seed("content_items", { topic_id: topic, title: "Test content" });
  const versions = [1, 2].map(version => f.seed("content_versions", { content_item_id: content, version, generation_mode: version === 1 ? "ai" : "manual", pack_json: "{}", full_script: "Synthetic script", short_script: "Short" }));
  for (const version of versions) f.seed("content_citations", { content_item_id: content, content_version_id: version, citation_type: "benchmark", citation_id: entry });
  f.seed("content_reviews", { content_item_id: content, content_version_id: versions[1], review_stage: "internal", round: 1, requested_by: f.input.userId, requested_at: f.now, decision: "approved" });
  const publication = f.seed("publication_records", { content_item_id: content, content_version_id: versions[1], platform: "douyin", status: "published" });
  f.seed("publication_metric_snapshots", { publication_id: publication, content_item_id: content, observed_at: "2026-09-08", views: 100 });
  f.seed("publication_metric_snapshots", { publication_id: publication, content_item_id: content, observed_at: "2026-09-09", views: 250 });
  const scope = { organizationId: f.organizationId, projectId: "source" };
  const all = await readBenchmarkFeedback(f.db, scope), selected = await readBenchmarkFeedback(f.db, { ...scope, entryIds: [entry] });
  assert.deepEqual(selected.results, all.results);
  const feedback = materialFeedbackFromRow(selected.results[0]);
  assert.equal(feedback.usageCount, 1); assert.equal(feedback.manualRevisionCount, 1);
  assert.equal(feedback.approvedCount, 1); assert.equal(feedback.publishedCount, 1); assert.equal(feedback.performance.views, 250);
  assert.equal((await readBenchmarkFeedback(f.db, { ...scope, projectId: "target" })).results.length, 0);
  assert.equal((await readBenchmarkFeedback(f.db, { ...scope, entryIds: [] })).results.length, 0);
});

test("shared model parser preserves caller whitespace and tool argument policies", () => {
  const payload = { choices: [{ message: { content: [{ type: "text", text: "  hello " }, { content: " world  " }] } }] };
  assert.equal(extractResponseText(payload), "  hello  world  ");
  assert.equal(extractResponseText(payload, { trim: true }), "helloworld");
  const toolOnly = { choices: [{ message: { tool_calls: [{ function: { arguments: '{"ok":true}' } }] } }] };
  assert.equal(extractResponseText(toolOnly), null);
  assert.equal(extractResponseText(toolOnly, { toolArguments: true }), '{"ok":true}');
  for (const value of [null, {}, { choices: [] }, { content: "   " }]) assert.equal(extractResponseText(value), null);
});

test("client helpers retain server errors and handle empty responses and dates", async () => {
  assert.equal(await readApiError(Response.json({ error: { message: "原错误" } })), "原错误");
  assert.equal(await readApiError(new Response("not-json"), "备用提示"), "备用提示");
  assert.equal(await readApiError(Response.json({ error: { message: "" } }), "备用提示"), "备用提示");
  assert.equal(formatClientDate(null), "—"); assert.equal(formatClientDate("invalid", "fullDate", "时间未知"), "时间未知");
  assert.equal(formatClientDate("2026-09-10T00:00:00Z", "date"), new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date("2026-09-10T00:00:00Z")));
});

test("pending blocks duplicate analysis without allowing worker artifacts, including SQL predicates", t => {
  const f = runtimeFixture(t);
  for (const status of ["pending", "queued", "analyzing", "completed", "partial", "failed", "cancelled"]) {
    const row = f.sqlite.prepare(`SELECT ? IN (${ACTIVE_ANALYSIS_STATUSES_SQL}) AS active, ? IN (${LEASED_ANALYSIS_STATUSES_SQL}) AS leased`).get(status, status);
    assert.equal(Boolean(row.active), isActiveAnalysisStatus(status)); assert.equal(Boolean(row.leased), isLeasedAnalysisStatus(status));
  }
  assert.equal(isActiveAnalysisStatus("pending"), true); assert.equal(isLeasedAnalysisStatus("pending"), false);
  assert.equal(isActiveAnalysisStatus("partial"), false); assert.equal(isLeasedAnalysisStatus("completed"), false);
});

test("rapid project switching consumes cancelled loads without hiding real network errors", async () => {
  const fetchBefore = globalThis.fetch, errors = [];
  try {
    resetClientScope({ organizationId: "test-org", projectId: "old-project" });
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
    const oldLoad = runScopedAction(async () => { await scopedFetch("http://localhost/api/topics"); }, message => errors.push(message));
    resetClientScope({ organizationId: "test-org", projectId: "new-project" });
    await oldLoad;
    assert.deepEqual(errors, []);
    globalThis.fetch = async () => { throw new Error("network unavailable"); };
    await runScopedAction(async () => { await scopedFetch("http://localhost/api/topics"); }, message => errors.push(message));
    assert.deepEqual(errors, ["network unavailable"]);
  } finally {
    globalThis.fetch = fetchBefore;
    resetClientScope({ organizationId: "", projectId: "" });
  }
});
