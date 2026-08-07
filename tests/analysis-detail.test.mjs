import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("analysis detail re-checks project access and scopes every result query", async () => {
  const route = await readFile(new URL("../app/api/videos/[videoId]/route.ts", import.meta.url), "utf8");
  assert.match(route, /getProjectAccess/);
  assert.match(route, /v\.id = \? AND v\.organization_id = \? AND v\.project_id = \?/);
  assert.match(route, /video_transcripts WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /video_analyses WHERE organization_id = \? AND project_id = \? AND video_id = \?/);
  assert.match(route, /ORDER BY created_at DESC LIMIT 8/);
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
  assert.match(browserMedia, /a\.organization_id = v\.organization_id AND a\.project_id = v\.project_id/);
  assert.match(workerSource, /requireAnalyzerService/);
  assert.match(workerSource, /j\.lease_owner = \?/);
  assert.match(workerSource, /j\.lease_expires_at > \?/);
});

test("detail UI links transcript evidence to protected media time", async () => {
  const [workspace, detail] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /查看结果/);
  assert.match(detail, /currentTime = startMs \/ 1000/);
  assert.match(detail, /结构化分析与证据/);
  assert.match(detail, /公开指标/);
  assert.match(detail, /const coverFrame = keyframes\[0\]/);
  assert.match(detail, /本地分析封面/);
  assert.match(detail, /打开原始抖音链接/);
  assert.match(detail, /analysisVersions/);
  assert.match(detail, /对比版本/);
  assert.match(detail, /evidenceForInsight/);
  assert.match(detail, /定位证据/);
  assert.match(detail, /打开原视频核对/);
  assert.match(detail, /window\.open\(detail\.video\.source_url/);
  assert.match(detail, /detail\.video\.media_url \|\| detail\.video\.source_url/);
  assert.doesNotMatch(detail, /dangerouslySetInnerHTML/);
});
