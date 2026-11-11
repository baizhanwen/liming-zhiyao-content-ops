import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const lightTests = ["test_canonical_transcript.py", "test_content_module_protocol.py", "test_unified_analysis.py", "test_vision_batch_runtime.py", "test_visual_overlap.py", "test_pipeline_checkpoint_synchronization.py", "test_unified_manual_batching.py"];
test("Windows validation and full-package release run every new offline unified test with the existing locked light dependencies", () => {
  for (const workflow of ["../.github/workflows/windows-runtime-check.yml", "../.github/workflows/release-full.yml"]) {
    const content = read(workflow);
    for (const filename of lightTests) {
      assert.ok(content.includes(`services/analyzer/tests/${filename}`), `${workflow}: ${filename}`);
      assert.ok(existsSync(new URL(`../services/analyzer/tests/${filename}`, import.meta.url)));
    }
    assert.match(content, /services\/analyzer\/uv\.lock/);
    assert.doesNotMatch(content, /pip install[^\n]*(?:torch|funasr|paddle)/i);
  }
});

test("build metadata defaults to v11 while preserving explicitly injected deployment metadata", t => {
  const f = runtimeFixture(t);
  f.mockModule("cloudflare:workers", { env: {} });
  assert.equal(f.load("lib/build-info.ts").buildInfo.analysisContractVersion, "analysis.v11");
  const injected = runtimeFixture(t);
  injected.mockModule("cloudflare:workers", { env: { BUILD_ID: "synthetic-deployment", ANALYSIS_CONTRACT_VERSION: "analysis.v9" } });
  assert.equal(injected.load("lib/build-info.ts").buildInfo.buildId, "synthetic-deployment");
  assert.equal(injected.load("lib/build-info.ts").buildInfo.analysisContractVersion, "analysis.v9");
});

test("the candidate full release keeps unified source, readers and resources in the verified package", () => {
  const prepare = read("scripts/prepare-delivery.ps1"), verify = read("scripts/verify-delivery.mjs");
  for (const folder of ["services", "lib", "components", "resources"]) assert.ok(prepare.includes(`"${folder}"`));
  for (const filename of ["canonical_transcript.py", "content_module_protocol.py", "unified_analysis.py", "unified-report.ts", "analysis-report-view.ts", "analysis-module-retry.ts", "analysis-media.ts", "UnifiedReportContent.tsx"])
    assert.ok(verify.includes(filename), `Missing package dependency assertion: ${filename}`);
  assert.match(verify, /video-taxonomy\.v1\.json/);
  assert.match(prepare, /docs\\releases\\full-v20261111\.7\.md/);
  assert.match(read("../.github/workflows/release-full.yml"), /default: "full-v20261111\.7"/);
});
