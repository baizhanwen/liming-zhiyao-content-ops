import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("worker claim is atomic and only selects tenant-owned videos", async () => {
  const claim = await readFile(new URL("../app/api/internal/analysis-jobs/claim/route.ts", import.meta.url), "utf8");
  assert.match(claim, /UPDATE analysis_jobs/);
  assert.match(claim, /RETURNING id, organization_id/);
  assert.match(claim, /v\.organization_id = j\.organization_id AND v\.project_id = j\.project_id/);
  assert.match(claim, /j\.lease_expires_at <= \?/);
  assert.match(claim, /attempt_count = attempt_count \+ 1/);
  assert.match(claim, /INSERT INTO analyzer_workers/);
  assert.match(claim, /ON CONFLICT\(worker_id\) DO UPDATE/);
});

test("heartbeats use lease owner and optimistic job versions", async () => {
  const heartbeat = await readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/heartbeat/route.ts", import.meta.url), "utf8");
  assert.match(heartbeat, /lease_owner = \?/);
  assert.match(heartbeat, /version = \?/);
  assert.match(heartbeat, /lease_expires_at > \?/);
  assert.match(heartbeat, /validateHeartbeatTransition/);
  assert.match(heartbeat, /INSERT INTO analyzer_workers/);
  assert.match(heartbeat, /last_seen_at = excluded\.last_seen_at/);
});

test("analyzer startup can verify a real authenticated worker heartbeat", async () => {
  const [statusRoute, startScript] = await Promise.all([
    readFile(new URL("../app/api/internal/analyzer/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-analyzer-background.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(statusRoute, /requireAnalyzerService/);
  assert.match(statusRoute, /WHERE worker_id = \?/);
  assert.match(statusRoute, /ONLINE_WINDOW_MS = 45_000/);
  assert.match(startScript, /api\/internal\/analyzer\/status/);
  assert.match(startScript, /Test-AnalyzerHeartbeat/);
  assert.match(startScript, /did not report a live heartbeat within 15 seconds/);
  assert.match(startScript, /analyzer\.base-url/);
});

test("result submission is idempotent and scopes artifacts through the job tenant", async () => {
  const [complete, fail, retry, schema] = await Promise.all([
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/fail/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analysis-jobs/[jobId]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(complete, /job\.result_key === payload\.resultKey/);
  assert.match(complete, /INNER JOIN videos v ON v\.id = j\.video_id AND v\.organization_id = j\.organization_id AND v\.project_id = j\.project_id/);
  assert.match(complete, /INSERT INTO video_analyses/);
  assert.match(fail, /job\.result_key === payload\.resultKey/);
  assert.match(retry, /lease_owner = NULL/);
  assert.match(retry, /result_key = NULL/);
  assert.match(schema, /analysis_job_events/);
  assert.match(schema, /idx_analysis_jobs_claimable/);
});

test("internal APIs require a separate service bearer credential", async () => {
  const auth = await readFile(new URL("../lib/service-auth.ts", import.meta.url), "utf8");
  assert.match(auth, /ANALYZER_SERVICE_TOKEN/);
  assert.match(auth, /Authorization|authorization/);
  assert.match(auth, /crypto\.subtle\.digest/);
  assert.doesNotMatch(auth, /oai-authenticated-user-id/);
});

test("worker artifacts are lease-bound, tenant-scoped, and persisted through R2 metadata", async () => {
  const [artifacts, assetRoute, schema] = await Promise.all([
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[videoId]/assets/[assetId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(artifacts, /j\.lease_owner = \?/);
  assert.match(artifacts, /j\.version = \?/);
  assert.match(artifacts, /j\.lease_expires_at > \?/);
  assert.match(artifacts, /getMediaBucket\(\)\.put/);
  assert.match(artifacts, /organization_id, project_id, video_id/);
  assert.match(assetRoute, /a\.organization_id = \?/);
  assert.match(assetRoute, /a\.project_id = \?/);
  assert.match(assetRoute, /a\.video_id = \?/);
  assert.match(schema, /videoId: text\("video_id"\)/);
  assert.match(schema, /idx_media_assets_video_kind/);
});
