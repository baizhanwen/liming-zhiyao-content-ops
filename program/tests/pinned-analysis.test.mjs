import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const source = "pinned-source-project", target = "pinned-target-project", now = "2026-01-01T00:00:00.000Z";
  const readable = new Set([source, target]); let libraryReadable = true, signedIn = true;
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, project_id: source, created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)); return row.id;
  };
  for (const id of [source, target]) seed("projects", { id, name: "Synthetic", client_name: "Synthetic" });
  const videoId = seed("videos", { id: "pinned-video", platform: "upload", source_type: "upload" });
  const otherVideoId = seed("videos", { id: "pinned-other-video", platform: "upload", source_type: "upload" });
  const entryId = seed("video_library_entries", { source_video_id: videoId });
  const analyses = Array.from({ length: 12 }, (_, index) => seed("video_analyses", { id: `pinned-analysis-${index}`, video_id: videoId, schema_version: "analysis.v1", report_json: JSON.stringify({ sentinel: index }), created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const otherAnalysisId = seed("video_analyses", { id: "pinned-other-analysis", video_id: otherVideoId, schema_version: "analysis.v1", report_json: '{"privateOtherVideo":true}' });
  const wrongProjectAnalysisId = seed("video_analyses", { id: "pinned-wrong-project-analysis", project_id: target, video_id: videoId, schema_version: "analysis.v1", report_json: '{"privateOtherProject":true}' });
  f.mock("lib/request-auth.ts", { readRequestIdentity: async () => signedIn ? { authSubject: owner.userId } : null });
  f.runtime.getProjectAccess = async (_subject, organizationId, projectId) => organizationId === owner.organizationId && readable.has(projectId) ? { organizationRole: "admin", projectRole: "member" } : null;
  f.runtime.canWriteProjectAccess = () => true;
  f.runtime.getOrganizationAccess = async (_subject, organizationId) => organizationId === owner.organizationId && libraryReadable ? { organizationRole: "admin", userId: owner.userId, organizationId } : null;
  f.runtime.canAccessOrganizationVideoLibrary = async () => libraryReadable;
  const read = (analysisId, extra = {}, selectedVideo = videoId) => {
    const query = new URLSearchParams({ organizationId: owner.organizationId, projectId: source, ...(analysisId ? { analysisId } : {}), ...extra });
    return f.load("app/api/videos/[videoId]/route.ts").GET(new Request(`http://localhost/api/videos/${selectedVideo}?${query}`), { params: Promise.resolve({ videoId: selectedVideo }) });
  };
  const reference = (status = "active", purpose = "benchmark") => seed("project_video_references", { library_entry_id: entryId, project_id: target, purpose, status });
  return { ...f, owner, source, target, videoId, otherVideoId, entryId, analyses, otherAnalysisId, wrongProjectAnalysisId, read, reference, readable, disableLibrary: () => { libraryReadable = false; }, logout: () => { signedIn = false; } };
}

test("pinned analysis reads an exact report older than the eight-version history window", async t => {
  const f = await fixture(t), changes = f.sqlite.prepare("SELECT total_changes() count").get().count;
  const latest = await f.read(); assert.equal(latest.status, 200);
  const ordinary = await latest.json(); assert.equal(ordinary.analysis.id, f.analyses.at(-1)); assert.equal(ordinary.analyses.length, 8);
  assert.ok(!ordinary.analyses.some(row => row.id === f.analyses[0]));
  const pinned = await f.read(f.analyses[0]); assert.equal(pinned.status, 200);
  const body = await pinned.json(); assert.equal(body.analysis.id, f.analyses[0]); assert.deepEqual(body.analysis.report, { sentinel: 0 });
  assert.equal(body.analyses.length, 8); assert.equal(body.analyses[0].id, f.analyses[0]);
  assert.equal(f.sqlite.prepare("SELECT total_changes() count").get().count, changes);
});

test("unknown, cross-video and cross-project analysis IDs return 404 within an authorized project", async t => {
  const f = await fixture(t);
  for (const id of ["unknown-analysis-id", f.otherAnalysisId, f.wrongProjectAnalysisId]) {
    const response = await f.read(id); assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "ANALYSIS_NOT_FOUND");
  }
  assert.equal((await f.read(f.analyses[0], {}, f.otherVideoId)).status, 404);
  assert.equal((await f.read("x".repeat(201))).status, 400);
});

test("cross-project pinned reports require an active benchmark reference", async t => {
  const f = await fixture(t);
  assert.equal((await f.read(f.analyses[0], { projectId: f.target })).status, 404);
  f.reference();
  const response = await f.read(f.analyses[0], { projectId: f.target }); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.analysis.id, f.analyses[0]); assert.equal(body.canWrite, false); assert.equal(body.video.is_shared_reference, true);
  f.sqlite.prepare("UPDATE project_video_references SET status='revoked'").run();
  assert.equal((await f.read(f.analyses[0], { projectId: f.target })).status, 404);
  f.sqlite.prepare("UPDATE project_video_references SET status='active',purpose='analysis'").run();
  assert.equal((await f.read(f.analyses[0], { projectId: f.target })).status, 404);
});

test("company library pinned reads use company-library permission without widening video or project scope", async t => {
  const f = await fixture(t);
  const query = { projectId: f.target, libraryEntryId: f.entryId };
  const response = await f.read(f.analyses[0], query); assert.equal(response.status, 200);
  assert.equal((await response.json()).analysis.id, f.analyses[0]);
  assert.equal((await f.read(f.otherAnalysisId, query)).status, 404);
  assert.equal((await f.read(f.analyses[0], query, f.otherVideoId)).status, 404);
  f.disableLibrary(); assert.equal((await f.read(f.analyses[0], query)).status, 404);
  f.readable.delete(f.target); assert.equal((await f.read(f.analyses[0], query)).status, 403);
  assert.equal((await f.read(f.analyses[0], { organizationId: "foreign-company" })).status, 403);
  f.logout(); assert.equal((await f.read(f.analyses[0])).status, 401);
});
