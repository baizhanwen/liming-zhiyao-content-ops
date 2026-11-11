import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("analysis detail re-checks project access and scopes every result query", async () => {
  const route = await readFile(new URL("../app/api/videos/[videoId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /getProjectAccess/);
  assert.match(route, /v\.id = \? AND v\.organization_id = \? AND v\.project_id = \?/);
  assert.match(route, /video_transcripts WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /video_analyses WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /SELECT id, analysis_job_id, schema_version/);
  assert.match(route, /SELECT id, analysis_job_id, kind/);
  assert.match(route, /created_at DESC(?:, rowid DESC)? LIMIT 8/);
  assert.match(route, /CASE WHEN id = \? THEN 0 ELSE 1 END/);
  assert.match(route, /analyses: analysisVersions/);
  assert.match(route, /analysis_job_events WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
});

test("private media endpoints protect both user and worker reads", async () => {
  const [browserMedia, workerSource] = await Promise.all([
    readFile(new URL("../app/api/videos/[videoId]/media/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/source/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(browserMedia, /readRequestIdentity/);
  assert.match(browserMedia, /getProjectAccess/);
  assert.match(browserMedia, /readScopedAnalysisMedia/);
  const mediaScope = await readFile(new URL("../lib/analysis-media.ts", import.meta.url), "utf8");
  assert.match(mediaScope, /a\.organization_id\s*=\s*v\.organization_id AND a\.project_id\s*=\s*v\.project_id/);
  assert.match(mediaScope, /analysis_job_id/);
  assert.match(mediaScope, /source_video.*source_audio/);
  assert.match(workerSource, /requireAnalyzerService/);
  assert.match(workerSource, /j\.lease_owner = \?/);
  assert.match(workerSource, /j\.lease_expires_at > \?/);
});

test("detail uses one unified report body with a real local-media seek and explicit history", async () => {
  const [workspace, detail] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /查看结果/);
  assert.match(detail, /\.currentTime\s*=/);
  assert.match(detail, /UnifiedReportContent/);
  assert.match(detail, /!view\.invalid/);
  assert.match(detail, /analysisId/);
  assert.match(detail, /media_url/);
  assert.match(detail, /moduleKeys/);
  assert.match(detail, /transcript/);
  assert.doesNotMatch(detail, /ContentAnalysisPanel|qualityAudit\.score|visual-understanding-status|dangerouslySetInnerHTML/);
});
test("analysis detail merges the latest confirmed XLSX work snapshot", async () => {
  const route = await readFile(new URL("../app/api/videos/[videoId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /FROM platform_works w/);
  assert.match(route, /w\.video_id = \? AND w\.match_status = 'confirmed'/);
  assert.match(route, /platform_metric_import_batches latest_batch/);
  assert.match(route, /ownedPerformance/);
});

test("CTA and old report compatibility are projected into the common four-module view", async () => {
  const [detail, view] = await Promise.all([
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/analysis-report-view.ts", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /analysisReportView/);
  assert.match(view, /legacyCtaFindings/);
  assert.match(view, /report\.cta_analysis/);
  assert.match(view, /unifiedModuleKeys/);
  assert.doesNotMatch(detail, /normalizeCtaAnalysis|reportSectionOrder|report-sections|CtaAnalysisPanel/);
});
