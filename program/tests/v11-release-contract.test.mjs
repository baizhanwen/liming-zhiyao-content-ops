import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const lightTests = [
  "test_canonical_transcript.py", "test_canonical_review.py", "test_instructor_single_attempt.py", "test_reviewed_analysis.py",
  "test_content_review.py", "test_content_module_protocol.py", "test_unified_analysis.py", "test_vision_batch_runtime.py",
  "test_visual_overlap.py", "test_pipeline_checkpoint_synchronization.py", "test_unified_manual_batching.py",
  "test_cuda_runtime.py", "test_prepare_analyzer_cuda.py", "test_check_analyzer_cuda.py", "test_prepare_analyzer_models.py",
  "test_diagnose_whisper_gpu.py", "test_gpu_diagnostics.py", "test_faster_whisper_asr.py", "test_transcript_checkpoints.py",
  "test_process_runtime.py", "test_windows_runtime.py", "test_durable_source_http.py", "test_reference_overflow_recovery.py", "test_transcript_review_mode.py",
  "test_quality_speech.py::test_ct2_auto_recovers_gpu_failures_without_partial_or_duplicate_output",
];
const windowsNodeTests = [
  "reviewed-analysis-contract.test.mjs", "transcript-ready-checkpoint.test.mjs", "original-analysis-contract.test.mjs",
  "transcript-review-option.test.mjs", "analysis-transcript-review-toggle.test.mjs", "v11-release-contract.test.mjs",
];
test("Windows validation and full-package release run the offline analysis stability contracts with locked light dependencies", () => {
  for (const workflow of ["../.github/workflows/windows-runtime-check.yml", "../.github/workflows/release-full.yml"]) {
    const content = read(workflow);
    for (const filename of lightTests) {
      assert.ok(content.includes(`services/analyzer/tests/${filename}`), `${workflow}: ${filename}`);
      assert.ok(existsSync(new URL(`../services/analyzer/tests/${filename.split("::")[0]}`, import.meta.url)));
    }
    assert.match(content, /services\/analyzer\/uv\.lock/);
    assert.doesNotMatch(content, /pip install[^\n]*(?:torch|funasr|paddle)/i);
    assert.match(content, /GPU checks use offline mocks; real CUDA inference requires the target machine's diagnostic JSON/);
    if (workflow.includes("windows-runtime-check")) {
      for (const filename of windowsNodeTests) {
        assert.ok(content.includes(`tests/${filename}`), `${workflow}: ${filename}`);
        assert.ok(existsSync(new URL(filename, import.meta.url)));
      }
    } else assert.match(content, /run: npm test/);
  }
});

test("build metadata defaults to v12 while preserving explicitly injected deployment metadata", t => {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: {} });
  assert.equal(f.load("lib/build-info.ts").buildInfo.analysisContractVersion, "analysis.v12");
  const injected = runtimeFixture(t);
  injected.mockModule("cloudflare:workers", { env: { BUILD_ID: "synthetic-deployment", ANALYSIS_CONTRACT_VERSION: "analysis.v9" } });
  assert.equal(injected.load("lib/build-info.ts").buildInfo.buildId, "synthetic-deployment");
  assert.equal(injected.load("lib/build-info.ts").buildInfo.analysisContractVersion, "analysis.v9");
});

test("the candidate full release keeps unified source, readers and resources in the verified package", () => {
  const prepare = read("scripts/prepare-delivery.ps1"), verify = read("scripts/verify-delivery.mjs");
  for (const folder of ["services", "lib", "components", "resources"]) assert.ok(prepare.includes(`"${folder}"`));
  for (const filename of ["canonical_transcript.py", "canonical_review.py", "reviewed_analysis.py", "content_module_protocol.py", "unified_analysis.py", "cuda_runtime.py", "scripts/prepare_analyzer_cuda.py", "scripts/check_analyzer_cuda.py", "gpu_diagnostics.py", "faster_whisper_asr.py", "pipeline.py", "process_runtime.py", "api_client.py", "artifacts.py", "drizzle/0052_analysis_transcript_review.sql", "unified-report.ts", "analysis-report-view.ts", "analysis-module-retry.ts", "analysis-media.ts", "UnifiedReportContent.tsx"])
    assert.ok(verify.includes(filename), `Missing package dependency assertion: ${filename}`);
  assert.match(verify, /video-taxonomy\.v1\.json/);
  assert.match(prepare, /docs\\releases\\full-v20261111\.8\.md/);
  assert.match(read("../.github/workflows/release-full.yml"), /default: "full-v20261111\.8"/);
});
