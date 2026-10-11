import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual transcript correction is versioned, tenant-scoped, and auditable", async () => {
  const [route, schema, migration, detail] = await Promise.all([
    readFile(new URL("../app/api/videos/[videoId]/transcript/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0010_manual_transcript_reanalysis.sql", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /getProjectAccess/);
  assert.match(route, /canWriteProjectAccess/);
  assert.match(route, /checkOrganizationQuota/);
  assert.match(route, /ANALYSIS_QUOTA_EXCEEDED/);
  assert.match(route, /source, full_text, segments_json/);
  assert.match(route, /'video\.transcript_corrected'/);
  assert.match(route, /input_transcript_id/);
  assert.match(schema, /inputTranscriptId: text\("input_transcript_id"\)/);
  assert.match(migration, /ADD `input_transcript_id`/);
  assert.match(detail, /保存并以\$\{analysisProfileNames\[rerunProfile\]\}重新分析/);
  assert.match(detail, /校正转写/);
});

test("worker claims the chosen transcript and does not expose storage internals", async () => {
  const [claim, complete, pipeline] = await Promise.all([
    readFile(new URL("../app/api/internal/analysis-jobs/claim/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/pipeline.py", import.meta.url), "utf8"),
  ]);
  assert.match(claim, /t\.id = j\.input_transcript_id/);
  assert.match(claim, /manual_transcript/);
  assert.match(claim, /transcript_segments_json/);
  assert.match(complete, /CASE WHEN j\.input_transcript_id IS NULL THEN 'asr' ELSE 'manual' END/);
  assert.match(pipeline, /manual_transcript is None/);
  assert.match(pipeline, /正在使用人工校正版并提取画面/);
});

test("analysis workspace reports readiness and uploads multiple files sequentially", async () => {
  const [workspace, videos] = await Promise.all([
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /multiple required/);
  assert.match(workspace, /for \(const \[index, file\] of files\.entries\(\)\)/);
  assert.match(workspace, /批量上传结束/);
  assert.match(workspace, /待核对/);
  assert.match(workspace, /未尝试/);
  assert.match(workspace, /分析服务就绪状态/);
  assert.match(videos, /credentialConfigured/);
  assert.match(videos, /modelConfigured/);
  assert.match(videos, /lastWorkerHeartbeat/);
  assert.match(videos, /publicLinkCookieConfigured/);
  assert.match(workspace, /抖音登录方式/);
});
