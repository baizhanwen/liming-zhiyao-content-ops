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
  assert.match(readiness, /publicLinkAuthenticationMode = "anonymous"/);
  assert.doesNotMatch(readiness, /DOUYIN_LOGIN_REQUIRED/);
  assert.match(fromUrl, /resolveVideoSubmission[\s\S]*checkNewAnalysisAvailability\(\{[^}]*requiresBrowser: true/);
  assert.match(upload, /resolveVideoSubmission[\s\S]*checkNewAnalysisAvailability\(\{[^}]*requiresBrowser: false/);
});

test("analysis jobs can be cancelled or recovered after an expired lease", async () => {
  const [cancel, retry, workspace] = await Promise.all([
    readFile(new URL("../app/api/analysis-jobs/[jobId]/cancel/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analysis-jobs/[jobId]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(cancel, /status = 'cancelled'/);
  // Cancellation keeps the lease until the stopped processing tree is
  // acknowledged. Behaviour and fencing are exercised with SQLite separately.
  assert.doesNotMatch(cancel, /lease_owner = NULL/);
  assert.match(retry, /staleLease/);
  assert.match(retry, /lease_expires_at/);
  assert.match(workspace, /cancelJob/);
  assert.match(workspace, /jobActionId/);
  assert.match(workspace, /\[WinError 2\]/);
  assert.match(workspace, /tools\\\\setup-analyzer\.bat/);
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
  assert.match(claim, /checkpoint_stage IN \('evidence_ready', 'segment_progress'\)/);
  assert.match(claim, /job\.checkpoint_stage === "evidence_ready" \|\| job\.checkpoint_stage === "segment_progress"/);
  assert.match(retry, /\["partial", "failed"\]\.includes\(job\.status\)/);
  assert.match(retry, /等待从证据检查点继续结构分析/);
  assert.match(complete, /checkpoint_json = \?/);
  assert.match(complete, /previous_spoken_script_set/);
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
  assert.match(provider, /scene_plus_timeline/);
  assert.match(provider, /visual_extraction/);
  assert.match(detail, /UnifiedReportContent/);
  assert.match(detail, /exportMarkdown/);
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

test("unified reports preserve original-transcript search, section navigation and local export", async () => {
  const [detail, styles] = await Promise.all([
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /visibleOriginal/);
  assert.match(detail, /type="search"/);
  assert.match(detail, /exportMarkdown/);
  assert.match(detail, /unifiedReportMarkdown/);
  assert.match(detail, /report-section-nav/);
  assert.match(styles, /report-original-tools/);
  assert.match(styles, /report-primary-actions/);
});

test("new analysis tasks support standard and max while legacy values remain readable", async () => {
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
  assert.match(profiles, /analysisProfiles = \["standard", "max"\]/);
  assert.match(profiles, /historicalAnalysisProfiles = \["economy", "deep"\]/);
  assert.match(fromUrl, /normalizeAnalysisProfile/);
  assert.match(upload, /analysisProfile/);
  assert.match(claim, /analysis_profile/);
  assert.match(reanalyze, /reanalysis_created/);
  assert.match(workspace, /useAnalysisProfile\(\)/);
  assert.match(workspace, /标准模式 · 推荐/);
  const preference = await readFile(new URL("../components/useAnalysisProfile.ts", import.meta.url), "utf8");
  assert.match(preference, /fallback: AnalysisProfile = "standard"/);
  assert.match(preference, /liming\.analysisProfile\.v1/);
  assert.match(provider, /64_000/);
  assert.match(provider, /12_000/);
  assert.match(provider, /profile_segment_limit = 12 if profile == "max" else 6/);
  assert.match(provider, /single_pass_standard/);
});

test("analysis submissions show v12 text estimates and retain per-request output caps", async () => {
  const [profiles, workspace, provider, modelCompat, detail] = await Promise.all([
    readFile(new URL("../lib/analysis-profile.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../services/analyzer/liming_analyzer/model_compat.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(profiles, /estimateMediaSourceTokens/);
  assert.match(profiles, /pipelineVersion: "analysis\.v12"/);
  assert.match(profiles, /visualTokens: null/);
  assert.match(workspace, /readMediaDuration/);
  assert.match(workspace, /短视频文字预算参考/);
  assert.match(workspace, /profileLabels\[analysisProfile\]/);
  assert.doesNotMatch(workspace, /30 分钟以上媒体|自动分段分析后汇总|主体 \+ 专项双阶段合成/);
  assert.match(provider, /completion_options\(self\.provider, self\.model, output_tokens\)/);
  assert.match(modelCompat, /"max_completion_tokens": output_tokens/);
  assert.match(modelCompat, /"max_tokens": output_tokens/);
  assert.match(provider, /"maximum_total_tokens"/);
  assert.match(detail, /UnifiedReportContent/);
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
  assert.match(detail, /UnifiedReportContent/);
});

test("analysis reports produce one faithful AI-corrected script and specialist operating insights", async () => {
  const [provider, detail, styles] = await Promise.all([
    readFile(new URL("../services/analyzer/liming_analyzer/providers.py", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(provider, /video-analysis\.v10-content-v1/);
  assert.match(provider, /DeepCoreReport/);
  assert.match(provider, /DeepInsightReport/);
  assert.match(provider, /dual_pass_full/);
  assert.match(provider, /profile_output_budget = 12_000 if profile == "max" else 6_000/);
  assert.match(provider, /length_contract/);
  assert.match(provider, /target_maximum_chinese_characters/);
  assert.match(provider, /instructor\.Mode\.JSON/);
  assert.match(provider, /_recover_partial_json_report/);
  assert.match(provider, /recovered_json_outputs/);
  assert.match(provider, /_assess_report_quality/);
  assert.match(provider, /quality_audit/);
  assert.match(provider, /spoken_script_set/);
  assert.match(provider, /def _generate_corrected_script/);
  assert.match(provider, /corrected_original/);
  assert.match(provider, /model_transcript_correction/);
  assert.match(provider, /spoken-script-correction\.v1/);
  assert.match(provider, /rewrite_variant_requests/);
  assert.match(provider, /transcript_correction/);
  assert.match(provider, /token_usage_by_stage/);
  assert.match(provider, /主体报告禁止输出 spoken_script/);
  assert.match(provider, /hook_analysis/);
  assert.match(provider, /viral_points/);
  assert.match(provider, /rhythm_analysis/);
  assert.match(provider, /emotion_curve/);
  assert.match(provider, /conversion_design/);
  assert.match(provider, /class CTAAnalysis/);
  assert.match(provider, /cta_analysis: CTAAnalysis/);
  assert.match(provider, /def _normalize_cta_analysis/);
  assert.match(provider, /"contract_version": "analysis\.v10" if self\.generate_content_features else "analysis\.v9"/);
  assert.match(provider, /"cta_validation"/);
  assert.match(provider, /insight_evidence/);
  assert.match(provider, /SegmentReport/);
  assert.match(provider, /_repair_report_evidence/);
  assert.match(provider, /evidence_repair/);
  assert.doesNotMatch(provider, /model report did not preserve exact source evidence/);
  assert.match(detail, /copyScript/);
  assert.match(detail, /UnifiedReportContent/);
  assert.match(detail, /unifiedReportMarkdown/);
  assert.match(detail, /moduleKeys/);
  assert.doesNotMatch(detail, /spoken-script-tabs|visual-understanding-status|analysis-quality-audit|qualityAudit\.score/);
  assert.match(styles, /report-manuscript/);
  assert.match(styles, /unified-report-section/);
});
