import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { analysisReportFixture, contentAnalysisFixture, setKnown, unifiedAnalysisReportFixture } from "./helpers/content-analysis-fixture.mjs";
import { contentTaxonomy } from "../lib/video-content-analysis.ts";

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const project = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO projects(id,organization_id,name,client_name,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(project, owner.organizationId, "Comparison fixture", "Synthetic", owner.userId, owner.userId, now, now);
  let signedIn = true, allowed = true;
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => signedIn ? { authSubject: owner.userId } : null });
  f.runtime.getOrganizationAccess = async () => allowed ? { organizationId: owner.organizationId, userId: owner.userId, organizationRole: "admin" } : null;
  f.runtime.canAccessOrganizationVideoLibrary = async () => true;
  f.runtime.getProjectAccess = async (_subject, organizationId, projectId) => allowed && organizationId === owner.organizationId && projectId === project ? { allowed: true } : null;
  function entry(index, organizationId = owner.organizationId) {
    const videoId = `comparison-video-${index}`, entryId = `comparison-entry-${index}`;
    f.sqlite.prepare("INSERT INTO videos(id,organization_id,project_id,platform,source_type,title,status,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'upload','upload',?,'ready',?,?,?,?)").run(videoId, organizationId, project, `Synthetic ${index}`, owner.userId, owner.userId, now, now);
    f.sqlite.prepare("INSERT INTO video_library_entries(id,organization_id,source_video_id,category,tags_json,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'other','[]',?,?,?,?)").run(entryId, organizationId, videoId, owner.userId, owner.userId, now, now);
    return { entryId, videoId };
  }
  function report(video, id, body = analysisReportFixture(), schema = "analysis.v10", createdAt = now) {
    f.sqlite.prepare("INSERT INTO video_analyses(id,organization_id,project_id,video_id,schema_version,report_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, owner.organizationId, project, video.videoId, schema, JSON.stringify(body), owner.userId, createdAt, createdAt);
  }
  function reference(video, status = "active", purpose = "benchmark") {
    f.sqlite.prepare("INSERT INTO project_video_references(id,organization_id,project_id,library_entry_id,purpose,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), owner.organizationId, project, video.entryId, purpose, status, owner.userId, now);
  }
  const invoke = (entryIds, extra = {}) => f.load("app/api/video-library/content-comparison/route.ts").POST(new Request("http://localhost/api/video-library/content-comparison", { method: "POST", body: JSON.stringify({ organizationId: owner.organizationId, scope: "library", entryIds, ...extra }), headers: { "Content-Type": "application/json" } }));
  return { ...f, owner, project, entry, report, reference, invoke, logout: () => { signedIn = false; }, revoke: () => { allowed = false; } };
}

test("comparison accepts both v10 and v11 and snapshots actual revisions without mixing transcript bases", async t => {
  const f = await fixture(t), a = f.entry("v10"), b = f.entry("v11"), v11 = unifiedAnalysisReportFixture();
  f.report(a, "accepted-v10");
  f.report(b, "accepted-v11", v11, "analysis.v11");
  const response = await f.invoke([a.entryId, b.entryId]); assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.summary.includedVideos, 2); assert.equal(result.snapshot.analysisSchemaVersion, "mixed");
  assert.deepEqual(result.snapshot.analysisSchemaVersions, ["analysis.v10", "analysis.v11"]);
  assert.deepEqual(result.snapshot.analyses.map(row => row.schemaVersion).sort(), ["analysis.v10", "analysis.v11"]);
  assert.equal(result.groupings.length, 2); assert.deepEqual(result.distributions, []);
  assert.deepEqual(result.groupings.map(row => row.transcriptBasis).sort(), ["canonical", "original"]);
  const broken = structuredClone(v11); delete broken.unified_report;
  f.report(b, "newer-unaccepted-v11", broken, "analysis.v11", "2099-01-01");
  const fallback = await (await f.invoke([a.entryId, b.entryId])).json();
  assert.equal(fallback.entries.find(row => row.entryId === b.entryId).analysisId, "accepted-v11");
});

test("comparison requires authentication and explicit deduplicated 2–100 selection", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2);
  assert.equal((await f.invoke([a.entryId, a.entryId])).status, 400);
  assert.equal((await f.invoke([a.entryId])).status, 400);
  assert.equal((await f.invoke(Array.from({ length: 101 }, (_, index) => `entry-${index}`))).status, 400);
  const response = await f.invoke([a.entryId, b.entryId, a.entryId]);
  assert.equal(response.status, 200); assert.equal((await response.json()).summary.selectedEntries, 2);
  f.logout(); assert.equal((await f.invoke([a.entryId, b.entryId])).status, 401);
});

test("comparison selects latest accepted v10 per video and never guesses legacy labels", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2), legacy = f.entry(3), missing = f.entry(4);
  const first = setKnown(contentAnalysisFixture(), "topic.category", ["topic.category.education"], "topic.category.education");
  f.report(a, "accepted-old", analysisReportFixture(first), "analysis.v10", "2020-01-01");
  const partial = analysisReportFixture(); partial.analysis_meta.quality_audit.acceptance_passed = false;
  f.report(a, "new-partial", partial, "analysis.v10", "2026-01-01");
  f.report(b, "accepted-current");
  f.report(legacy, "legacy", { summary: "教育学习", tags: ["topic.category.education"] }, "analysis.v9");
  const changes = f.sqlite.prepare("SELECT total_changes() AS count").get().count;
  const response = await f.invoke([a.entryId, b.entryId, legacy.entryId, missing.entryId]); assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.summary, { selectedEntries: 4, selectedVideos: 4, includedVideos: 2, excludedVideos: 2 });
  assert.equal(body.entries[0].analysisId, "accepted-old");
  assert.equal(body.entries[2].excludedReason, "legacy"); assert.equal(body.entries[3].excludedReason, "missing");
  assert.equal(body.excluded.legacy, 1); assert.equal(body.excluded.missing, 1);
  assert.equal(body.entries[0].contentAnalysis.evidence_registry, undefined);
  assert.equal(body.entries[0].contentAnalysis.metrics.transcript_statistics.segments, undefined);
  assert.equal(body.distributions.find(row => row.dimensionId === "topic.category").knownCount, 1);
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS count").get().count, changes);
});

test("scope checks reject foreign selection and require active project benchmark references", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2);
  f.report(a, "a"); f.report(b, "b");
  assert.equal((await f.invoke([a.entryId, "missing-or-foreign-entry"])).status, 404);
  assert.equal((await f.invoke([a.entryId, b.entryId], { scope: "benchmark" })).status, 400);
  assert.equal((await f.invoke([a.entryId, b.entryId], { scope: "benchmark", projectId: "foreign-project" })).status, 403);
  f.reference(a); f.reference(b, "revoked");
  assert.equal((await f.invoke([a.entryId, b.entryId], { scope: "benchmark", projectId: f.project })).status, 404);
  f.sqlite.prepare("UPDATE project_video_references SET status='active'").run();
  assert.equal((await f.invoke([a.entryId, b.entryId], { scope: "benchmark", projectId: f.project })).status, 200);
  f.revoke(); assert.equal((await f.invoke([a.entryId, b.entryId])).status, 403);
});

test("selected records beyond a 300-entry listing remain part of server-side comparison", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 301; index++) f.entry(index);
  const a = f.entry(301), b = f.entry(302); f.report(a, "late-a"); f.report(b, "late-b");
  const response = await f.invoke([a.entryId, b.entryId]); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).snapshot.analyses.map(row => row.analysisId), ["late-a", "late-b"]);
});

test("comparison reports rejected v10 and incompatible sampling without silently mixing", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2), c = f.entry(3), d = f.entry(4);
  f.report(a, "a");
  const other = contentAnalysisFixture(); other.methodology.sampling_config.interval_seconds = 2; f.report(b, "b", analysisReportFixture(other));
  const future = contentAnalysisFixture(); future.taxonomy_version = "video-taxonomy.future"; f.report(c, "future", analysisReportFixture(future));
  const failed = analysisReportFixture(); failed.analysis_meta.quality_audit.status = "degraded"; f.report(d, "failed", failed);
  const response = await f.invoke([a.entryId, b.entryId, c.entryId, d.entryId]); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.groupings.length, 2); assert.deepEqual(body.distributions, []);
  assert.equal(body.excluded.unsupported_taxonomy, 1); assert.equal(body.excluded.quality_failed, 1);
});

test("comparison measures the total report budget before loading bodies", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2), prepare = f.db.prepare;
  f.db.prepare = query => {
    if (query.includes("report_bytes")) return { bind() { return this; }, async first() { return { report_count: 2, report_bytes: 20 * 1024 * 1024 + 1 }; } };
    if (query.startsWith("SELECT id, video_id, schema_version, report_json")) throw new Error("Report bodies must not be read after the budget was rejected.");
    return prepare(query);
  };
  assert.equal((await f.invoke([a.entryId, b.entryId])).status, 413);
});

test("comparison rejects permission or benchmark membership revoked while reading", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2), prepare = f.db.prepare;
  f.report(a, "a"); f.report(b, "b"); f.reference(a); f.reference(b);
  f.db.prepare = query => {
    if (query.startsWith("SELECT id, video_id, schema_version, report_json")) f.sqlite.prepare("UPDATE project_video_references SET status='revoked' WHERE library_entry_id=?").run(b.entryId);
    return prepare(query);
  };
  assert.equal((await f.invoke([a.entryId, b.entryId], { scope: "benchmark", projectId: f.project })).status, 409);
  f.db.prepare = query => { if (query.includes("report_bytes")) f.revoke(); return prepare(query); };
  assert.equal((await f.invoke([a.entryId, b.entryId])).status, 403);
});

test("comparison filters only accepted known classifications and snapshots the actual denominator", async t => {
  const f = await fixture(t), a = f.entry(1), b = f.entry(2), unknown = f.entry(3);
  const form = contentTaxonomy.dimensions.find(row => row.id === "content.form").tags.find(row => !row.disabled).id;
  const aContent = setKnown(setKnown(contentAnalysisFixture(), "topic.category", ["topic.category.education"], "topic.category.education"), "content.form", [form], form, ["vision:0001"]);
  aContent.evidence_registry.push({ id: "vision:0001", source: "vision", text: "合成的单人可见画面", start_ms: 0, end_ms: 1_000, asset_ref: null, frame_group_id: null });
  const bContent = setKnown(contentAnalysisFixture(), "topic.category", ["topic.category.career"], "topic.category.career");
  f.report(a, "a", analysisReportFixture(aContent)); f.report(b, "b", analysisReportFixture(bContent)); f.report(unknown, "unknown");
  const filters = { topicCategory: "topic.category.education", contentForm: form, durationBucket: "under_15s" };
  const response = await f.invoke([a.entryId, b.entryId, unknown.entryId], { filters }); assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.snapshot.filters, filters); assert.equal(body.summary.includedVideos, 1);
  assert.equal(body.excluded.filtered_out, 2); assert.equal(body.entries[1].excludedReason, "filtered_out");
  assert.equal(body.distributions.find(row => row.dimensionId === "topic.category").totalVideos, 1);
  assert.equal((await f.invoke([a.entryId, b.entryId], { filters: { topicCategory: "foreign.tag" } })).status, 400);
  assert.equal((await f.invoke([a.entryId, b.entryId], { filters: { contentForm: "topic.category.education" } })).status, 400);
  assert.equal((await f.invoke([a.entryId, b.entryId], { filters: { durationBucket: "unknown" } })).status, 400);
});

test("comparison rejects oversized matrix responses instead of returning a truncated sample", async t => {
  const f = await fixture(t), content = contentAnalysisFixture();
  content.evidence_registry = Array.from({ length: 24 }, (_, index) => ({ ...content.evidence_registry[0], id: `transcript:${String(index + 1).padStart(4, "0")}` }));
  for (const classification of content.classifications) {
    classification.reason = "x".repeat(600);
    classification.evidence_ids = content.evidence_registry.map(evidence => evidence.id);
  }
  const selection = [];
  for (let index = 0; index < 80; index++) { const video = f.entry(index); selection.push(video.entryId); f.report(video, `matrix-${index}`, analysisReportFixture(content)); }
  const response = await f.invoke(selection); assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "CONTENT_COMPARISON_TOO_LARGE");
});
