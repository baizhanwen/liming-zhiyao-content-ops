import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const lightTests = [
  "test_qwen_windows.py", "test_whisper_model_download.py", "test_canonical_transcript.py", "test_canonical_review.py", "test_instructor_single_attempt.py", "test_reviewed_analysis.py",
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
  for (const filename of ["canonical_transcript.py", "canonical_review.py", "reviewed_analysis.py", "content_module_protocol.py", "unified_analysis.py", "cuda_runtime.py", "scripts/prepare_analyzer_cuda.py", "scripts/check_analyzer_cuda.py", "gpu_diagnostics.py", "faster_whisper_asr.py", "whisper_model_download.py", "pipeline.py", "process_runtime.py", "api_client.py", "artifacts.py", "drizzle/0052_analysis_transcript_review.sql", "unified-report.ts", "analysis-report-view.ts", "analysis-module-retry.ts", "analysis-media.ts", "UnifiedReportContent.tsx",
    "app/api/dashboard/route.ts", "components/DashboardWorkspace.tsx", "components/dashboard-workspace.css", "lib/dashboard-period.ts", "lib/work-tasks.ts",
    "lib/source-artifact-body.ts", "lib/analysis-collection-mode.ts", "lib/analysis-execution-mode.ts",
    "components/analysis-cleanup.css", "components/AnalysisCollectionModeSelect.tsx", "components/AnalysisExecutionModeSelect.tsx",
    "services/analyzer/liming_analyzer/collection_mode.py", "services/analyzer/liming_analyzer/execution_mode.py",
    "services/analyzer/liming_analyzer/douyin_collector/python/limits.py", "drizzle/0055_analysis_execution_mode.sql", "drizzle/0056_analysis_collection_mode.sql"])
    assert.ok(verify.includes(filename), `Missing package dependency assertion: ${filename}`);
  assert.match(verify, /video-taxonomy\.v1\.json/);
  const workflow = read("../.github/workflows/release-full.yml");
  const releaseTag = workflow.match(/default:\s*"(full-v\d{8}\.\d+)"/)?.[1];
  assert.ok(releaseTag, "Release workflow needs a versioned default tag");
  assert.ok(existsSync(new URL(`../docs/releases/${releaseTag}.md`, import.meta.url)), "The default release needs matching release notes");
  assert.ok(prepare.includes(`docs\\releases\\${releaseTag}.md`), "The customer package must include its current release notes");
});

function workflowJob(source, name) {
  const lines = source.split(/\r?\n/), start = lines.findIndex(line => line === `  ${name}:`);
  assert.ok(start >= 0, `Missing release job: ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^ {2}[a-zA-Z0-9_-]+:$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join("\n");
}

test("public release waits for cold installation and two actual transcriptions of the exact uploaded ZIP", () => {
  const workflow = read("../.github/workflows/release-full.yml");
  const build = workflowJob(workflow, "release"), cold = workflowJob(workflow, "cold-install-and-transcribe"), publish = workflowJob(workflow, "publish");
  assert.match(build, /actions\/upload-artifact@/); assert.match(build, /LimingZhiyao-Windows-Full/);
  assert.match(cold, /needs:\s*(?:release|\[\s*release\s*\])/);
  assert.match(cold, /actions\/download-artifact@/); assert.match(cold, /LimingZhiyao-Windows-Full/);
  assert.match(cold, /setup-local\.bat/); assert.match(cold, /verify-windows-qwen\.mjs/);
  assert.match(cold, /ACCEPTANCE_ZIP_SHA256/); assert.match(cold, /actions\/upload-artifact@/);
  const dependencies = publish.match(/needs:\s*\[([^\]]+)\]/)?.[1].split(",").map(value => value.trim()).sort();
  assert.deepEqual(dependencies, ["cold-install-and-transcribe", "release"]);
  assert.doesNotMatch(publish, /if:\s*(?:\$\{\{\s*)?always\(\)/);
  for (const field of ["passed", "revision", "zipSha256", "extractions"]) assert.match(publish, new RegExp(`\\.${field}\\b`));
  assert.match(publish, /GITHUB_SHA/); assert.match(publish, /Get-FileHash/); assert.match(publish, /SHA256/);
  for (const value of ["single", "multi", "completed"]) assert.match(publish, new RegExp(`["']${value}["']`));
  assert.match(publish, /gh release create/); assert.doesNotMatch(build, /gh release create/); assert.doesNotMatch(cold, /gh release create/);
});
