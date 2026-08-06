import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("analysis preflight rejects work that cannot finish", async () => {
  const [readiness, fromUrl, upload] = await Promise.all([
    readFile(new URL("../lib/analyzer-readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/from-url/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/upload/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(readiness, /ANALYZER_OFFLINE/);
  assert.match(readiness, /DOUYIN_COOKIE_REQUIRED/);
  assert.match(fromUrl, /analyzerReadinessError\(await readAnalyzerReadiness\(organizationId\), true\)/);
  assert.match(upload, /analyzerReadinessError\(await readAnalyzerReadiness\(organizationId\), false\)/);
});

test("analysis jobs can be cancelled or recovered after an expired lease", async () => {
  const [cancel, retry, workspace] = await Promise.all([
    readFile(new URL("../app/api/analysis-jobs/[jobId]/cancel/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analysis-jobs/[jobId]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(cancel, /status = 'cancelled'/);
  assert.match(cancel, /lease_owner = NULL,\s+lease_expires_at = NULL/);
  assert.match(retry, /staleLease/);
  assert.match(retry, /lease_expires_at/);
  assert.match(workspace, /cancelJob/);
  assert.match(workspace, /jobActionId/);
});

test("analysis retries resume from a durable evidence checkpoint", async () => {
  const [schema, migration, checkpoint, claim, retry, complete, pipeline, workspace] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0014_analysis_checkpoints.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/checkpoint/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/claim/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analysis-jobs/[jobId]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/[jobId]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/pipeline.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /checkpointStage: text\("checkpoint_stage"\)/);
  assert.match(migration, /ADD `checkpoint_json`/);
  assert.match(checkpoint, /parseCheckpointPayload/);
  assert.match(checkpoint, /lease_expires_at > \?/);
  assert.match(claim, /checkpoint_stage = 'evidence_ready'/);
  assert.match(retry, /等待从证据检查点继续结构分析/);
  assert.match(complete, /checkpoint_json = NULL/);
  assert.match(pipeline, /_restore_evidence_checkpoint/);
  assert.match(workspace, /从检查点继续/);
});

test("long videos use a bounded evidence budget and report coverage", async () => {
  const [provider, detail, worker] = await Promise.all([
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/worker.py", import.meta.url), "utf8"),
  ]);

  assert.match(provider, /max_source_tokens/);
  assert.match(provider, /transcript_windows/);
  assert.match(provider, /analysis_meta/);
  assert.match(provider, /coverage_percent/);
  assert.match(provider, /create_with_completion/);
  assert.match(provider, /actual_total_tokens/);
  assert.match(detail, /estimated_model_input_tokens/);
  assert.match(detail, /actual_total_tokens/);
  assert.match(detail, /copyReport/);
  assert.match(worker, /MODEL_CONTEXT_LIMIT/);
  assert.match(worker, /DOUYIN_COOKIE_EXPIRED/);
});

test("analysis tasks show queue estimates and actionable recovery guidance", async () => {
  const [videos, workspace] = await Promise.all([
    readFile(new URL("../app/api/videos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(videos, /average_seconds/);
  assert.match(videos, /sampleCount/);
  assert.match(workspace, /queueLabel/);
  assert.match(workspace, /errorGuidance/);
  assert.match(workspace, /DOUYIN_COOKIE_EXPIRED/);
  assert.match(workspace, /job-guidance/);
});

test("long analysis reports can be searched, navigated and exported locally", async () => {
  const [detail, styles] = await Promise.all([
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /transcriptQuery/);
  assert.match(detail, /visibleSegments/);
  assert.match(detail, /highlightedText/);
  assert.match(detail, /exportMarkdown/);
  assert.match(detail, /exportTranscript/);
  assert.match(detail, /analysis-detail-nav/);
  assert.match(styles, /transcript-search/);
  assert.match(styles, /report-heading-actions/);
});

test("analysis quality profiles persist from submission through worker budgets", async () => {
  const [schema, migration, profiles, fromUrl, upload, claim, reanalyze, workspace, provider] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_analysis_profiles.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/analysis-profile.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/from-url/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/internal/analysis-jobs/claim/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/[videoId]/reanalyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /analysisProfile: text\("analysis_profile"/);
  assert.match(migration, /ADD `analysis_profile`/);
  assert.match(profiles, /economy.*standard.*deep/);
  assert.match(fromUrl, /normalizeAnalysisProfile/);
  assert.match(upload, /analysisProfile/);
  assert.match(claim, /analysis_profile/);
  assert.match(reanalyze, /reanalysis_created/);
  assert.match(workspace, /profileHints/);
  assert.match(provider, /8_000/);
  assert.match(provider, /32_000/);
});

test("analysis submissions expose duration estimates and enforce total token ceilings", async () => {
  const [profiles, workspace, provider, detail] = await Promise.all([
    readFile(new URL("../lib/analysis-profile.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(profiles, /estimateMediaSourceTokens/);
  assert.match(profiles, /outputTokens: 6_000/);
  assert.match(workspace, /readMediaDuration/);
  assert.match(workspace, /短视频总预算/);
  assert.match(workspace, /30 分钟以上媒体/);
  assert.match(provider, /"max_tokens": output_tokens/);
  assert.match(provider, /"maximum_total_tokens"/);
  assert.match(detail, /maximum_total_tokens/);
});

test("thirty minute videos use bounded multi-pass analysis and cleaned evidence", async () => {
  const [profiles, provider, evidence, visual, pipeline, detail] = await Promise.all([
    readFile(new URL("../lib/analysis-profile.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/evidence.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/visual.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/pipeline.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(profiles, /estimateAnalysisMaximumTokens/);
  assert.match(provider, /duration_is_long.*1_800_000/);
  assert.match(provider, /segment_reports/);
  assert.match(provider, /processing_mode.*segmented/);
  assert.match(evidence, /clean_transcript/);
  assert.match(visual, /_image_signature/);
  assert.match(visual, /is_useful_ocr/);
  assert.match(pipeline, /clean_transcript/);
  assert.match(detail, /分段分析后汇总/);
});

test("analysis reports produce a reusable spoken script and specialist operating insights", async () => {
  const [provider, detail, styles] = await Promise.all([
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(provider, /video-analysis\.v4/);
  assert.match(provider, /spoken_script/);
  assert.match(provider, /hook_analysis/);
  assert.match(provider, /viral_points/);
  assert.match(provider, /rhythm_analysis/);
  assert.match(provider, /emotion_curve/);
  assert.match(provider, /conversion_design/);
  assert.match(provider, /SegmentReport/);
  assert.match(detail, /copySpokenScript/);
  assert.match(detail, /整理后的口播稿/);
  assert.match(detail, /传播爆点/);
  assert.match(styles, /spoken-script-panel/);
});
