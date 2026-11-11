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
  return { ...f, seed, owner, source, target, videoId, otherVideoId, entryId, analyses, otherAnalysisId, wrongProjectAnalysisId, read, reference, readable, disableLibrary: () => { libraryReadable = false; }, logout: () => { signedIn = false; } };
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

test("URL media uses the selected analysis source and keeps historical jobs separate from the latest queue", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE videos SET source_type='url',source_url='https://example.invalid/original' WHERE id=?").run(f.videoId);
  const oldJob = f.seed("analysis_jobs", { video_id: f.videoId, source_type: "url", source_ref: "https://example.invalid/original", idempotency_key: "old-media-job", status: "completed", created_at: "2020-01-01" });
  const latestJob = f.seed("analysis_jobs", { video_id: f.videoId, source_type: "url", source_ref: "https://example.invalid/original", idempotency_key: "latest-media-job", status: "failed", error_message: "Latest task must not replace the old report state", created_at: "2099-01-01" });
  f.sqlite.prepare("UPDATE video_analyses SET analysis_job_id=? WHERE id=?").run(oldJob, f.analyses[0]);
  const original = f.seed("media_assets", { video_id: f.videoId, analysis_job_id: oldJob, kind: "source_video", filename: "original.mp4", r2_key: "isolated-old-source", content_type: "video/mp4", size_bytes: 100, sha256: "a".repeat(64), status: "active" });
  const other = f.seed("media_assets", { video_id: f.videoId, analysis_job_id: latestJob, kind: "source_video", filename: "newer.mp4", r2_key: "isolated-new-source", content_type: "video/mp4", size_bytes: 100, sha256: "b".repeat(64), status: "active" });
  f.sqlite.prepare("UPDATE videos SET media_asset_id=? WHERE id=?").run(other, f.videoId);
  const body = await (await f.read(f.analyses[0])).json();
  assert.equal(body.job.id, oldJob); assert.equal(body.job.status, "completed");
  assert.equal(body.latestJob.id, latestJob);
  assert.equal(body.video.filename, "original.mp4"); assert.equal(body.video.media_binding, "analysis");
  assert.match(body.video.media_url, new RegExp(`analysisId=${f.analyses[0]}`));

  const readKeys = [];
  f.runtime.getMediaObject = async (key, options) => {
    readKeys.push(key); assert.equal(options.range.get("range"), "bytes=10-19");
    return { source: "primary", object: { body: "0123456789", size: 100, range: { offset: 10, length: 10 }, httpEtag: '"fixture"', writeHttpMetadata: headers => headers.set("content-type", "video/mp4") } };
  };
  const direct = f.load("app/api/videos/[videoId]/media/route.ts");
  const readMedia = id => direct.GET(new Request(`http://localhost/media?organizationId=${f.owner.organizationId}&projectId=${f.source}&analysisId=${id}`, { headers: { range: "bytes=10-19" } }), { params: Promise.resolve({ videoId: f.videoId }) });
  const response = await readMedia(f.analyses[0]); assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 10-19/100"); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(readKeys, ["isolated-old-source"]);
  assert.equal((await readMedia(f.otherAnalysisId)).status, 404);
  assert.equal((await readMedia("unknown-analysis")).status, 404);
  f.sqlite.prepare("UPDATE media_assets SET status='deleted' WHERE id=?").run(original);
  assert.equal((await readMedia(f.analyses[0])).status, 206);
  assert.equal(readKeys.at(-1), "isolated-new-source", "Legacy fallback is explicit, not falsely bound to the historical analysis");
  const fallback = await (await f.read(f.analyses[0])).json(); assert.equal(fallback.video.media_binding, "video");
});

test("library URL media validates both selected analysis and the source asset's company and project", async t => {
  const f = await fixture(t);
  const job = f.seed("analysis_jobs", { video_id: f.videoId, source_type: "url", source_ref: "https://example.invalid/video", idempotency_key: "library-media-job", status: "completed" });
  f.sqlite.prepare("UPDATE video_analyses SET analysis_job_id=? WHERE id=?").run(job, f.analyses[0]);
  const asset = f.seed("media_assets", { video_id: f.videoId, analysis_job_id: job, kind: "source_video", filename: "original.mp4", r2_key: "isolated-library-source", content_type: "video/mp4", size_bytes: 1, sha256: "a".repeat(64), status: "active" });
  f.sqlite.prepare("UPDATE videos SET source_type='url',media_asset_id=? WHERE id=?").run(asset, f.videoId);
  let reads = 0;
  f.runtime.getMediaObject = async () => { reads++; return { source: "primary", object: { body: "x", size: 1, httpEtag: '"fixture"', writeHttpMetadata: () => {} } }; };
  const media = f.load("app/api/video-library/[entryId]/media/route.ts");
  const read = analysisId => media.GET(new Request(`http://localhost/media?organizationId=${f.owner.organizationId}&projectId=${f.target}&analysisId=${analysisId}`), { params: Promise.resolve({ entryId: f.entryId }) });
  assert.equal((await read(f.analyses[0])).status, 200); assert.equal(reads, 1);
  assert.equal((await read(f.otherAnalysisId)).status, 404); assert.equal(reads, 1);
  f.sqlite.prepare("UPDATE media_assets SET project_id=? WHERE id=?").run(f.target, asset);
  assert.equal((await read(f.analyses[0])).status, 404); assert.equal(reads, 1);
});

test("historical reports use their contemporary raw transcript without overwriting a newer manual correction", async t => {
  const f = await fixture(t);
  f.seed("video_transcripts", { id: "original-asr", video_id: f.videoId, version: 1, language: "zh-CN", source: "asr", full_text: "历史原转写", segments_json: '[{"start_ms":0,"end_ms":1000,"text":"历史原转写"}]', created_at: "2026-01-01T00:00:00.000Z" });
  f.seed("video_transcripts", { id: "later-manual", video_id: f.videoId, version: 2, language: "zh-CN", source: "manual", full_text: "之后人工修正", segments_json: '[{"start_ms":0,"end_ms":1000,"text":"之后人工修正"}]', created_at: "2026-01-10T00:00:00.000Z" });
  const before = f.sqlite.prepare("SELECT * FROM video_transcripts ORDER BY version").all();
  const historical = await (await f.read(f.analyses[0])).json();
  assert.equal(historical.transcript.id, "original-asr"); assert.equal(historical.transcript.full_text, "历史原转写");
  assert.equal(historical.transcript_binding, "historical");
  const latest = await (await f.read()).json();
  assert.equal(latest.transcript.id, "later-manual"); assert.equal(latest.transcript_binding, "latest");
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM video_transcripts ORDER BY version").all(), before);
});

test("a later saved manuscript remains visible on latest and cannot become an older report's transcript", async t => {
  const f = await fixture(t);
  const latestReport = f.analyses.at(-1);
  f.seed("video_transcripts", { id: "first-asr", video_id: f.videoId, version: 1, source: "asr", language: "zh",
    full_text: "原始转写", segments_json: '[{"start_ms":0,"end_ms":900,"text":"原始转写"}]', created_at: "2026-01-15T00:00:00.000Z" });
  f.seed("video_transcripts", { id: "saved-correction", video_id: f.videoId, version: 2, source: "manual", language: "zh",
    full_text: "人工改词", segments_json: '[{"start_ms":0,"end_ms":900,"text":"人工改词"}]', created_at: "2026-01-16T00:00:00.000Z" });
  const latest = await (await f.read()).json();
  assert.equal(latest.analysis.id, latestReport);
  assert.equal(latest.transcript.full_text, "人工改词");
  assert.equal(latest.original_asr_segments[0].text, "原始转写");
  const historical = await (await f.read(latestReport)).json();
  assert.equal(historical.transcript, null);
  assert.deepEqual(historical.analysis.report, latest.analysis.report);
});

test("latest extraction plays its own saved source while the old analysis keeps its original media binding", async t => {
  const f = await fixture(t);
  const job = f.seed("analysis_jobs", { video_id: f.videoId, source_type: "url", source_ref: "https://example.invalid/clip", idempotency_key: "transcript:media", status: "completed" });
  const output = (kind, filename, r2_key, content_type) => f.seed("media_assets", {
    video_id: f.videoId, analysis_job_id: job, kind, filename, r2_key, content_type,
    size_bytes: 100, sha256: "a".repeat(64), status: "active", created_at: "2026-01-20T00:00:00.000Z" });
  output("subtitle", "manuscript.json", "new-manuscript", "application/json");
  const source = output("source_video", "new-source.mp4", "new-original", "video/mp4");
  const latest = await (await f.read()).json();
  assert.equal(latest.video.media_binding, "manuscript");
  assert.match(latest.video.media_url, new RegExp(`/assets/${source}\\?`));
  assert.equal(latest.video.filename, "new-source.mp4");
  const old = await (await f.read(f.analyses[0])).json();
  assert.equal(old.video.media_url, null);
});
