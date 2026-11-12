import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_RUNTIME_PROTOCOL = 2;

export function runtimeInstallationId(root) {
  let canonical = path.resolve(root);
  try { canonical = realpathSync(canonical); } catch { /* A not-yet-created fixture still has a stable identity. */ }
  canonical = canonical.replace(/[\\/]+$/u, "");
  if (process.platform === "win32") canonical = canonical.toUpperCase();
  return createHash("sha256").update(canonical).digest("hex");
}

// Executable source and its versioned taxonomy participate; private state never does.
export function runtimeSourceId(root) {
  const hash = createHash("sha256");
  for (const name of [
    "scripts/local-runtime-identity.mjs", "scripts/local-runtime-endpoint.mjs",
    "scripts/analyzer-environment-bridge.mjs", "scripts/analyzer_local_runtime.py",
    "scripts/analyzer-windows-control.ps1", "scripts/analyzer-windows-identity.ps1",
    "scripts/start-analyzer-background.ps1", "scripts/run-analyzer-supervisor.ps1",
    "scripts/start-web-with-environment.mjs", "scripts/prepare-runtime-configuration.mjs",
    "scripts/local-web-identity.ps1", "scripts/run-web-guard.ps1",
    "scripts/node-runtime-policy.mjs", "scripts/install-node22.ps1", "scripts/prepare-local-web.ps1",
    "scripts/start-lan.ps1", "scripts/analyzer-collector-runtime.ps1",
    "setup-local.bat", "start-local.bat",
    "build/analyzer-environment-plugin.ts", "lib/analyzer-environment.ts",
    "app/api/health/route.ts", "lib/build-info.ts",
    "services/analyzer/liming_analyzer/douyin_collector/adapter.py",
    "services/analyzer/liming_analyzer/sources.py",
    "services/analyzer/liming_analyzer/providers.py",
    "services/analyzer/liming_analyzer/pipeline.py", "services/analyzer/liming_analyzer/process_runtime.py",
    "services/analyzer/liming_analyzer/api_client.py",
    "services/analyzer/liming_analyzer/artifacts.py",
    "services/analyzer/liming_analyzer/bootstrap.py", "services/analyzer/liming_analyzer/__main__.py",
    "services/analyzer/liming_analyzer/faster_whisper_asr.py", "services/analyzer/liming_analyzer/quality_speech.py",
    "services/analyzer/liming_analyzer/subtitle_evidence.py", "services/analyzer/liming_analyzer/qwen_speech.py",
    "services/analyzer/liming_analyzer/qwen_windows.py", "resources/media-tools/asr-check-zh.wav",
    "services/analyzer/liming_analyzer/manuscript_punctuation.py", "scripts/prepare_analyzer_models.py",
    "components/ExtractedManuscript.tsx", "lib/manuscript-view.ts", "lib/analyzer-readiness.ts",
    "app/api/videos/[videoId]/reanalyze/route.ts", "app/api/internal/analysis-jobs/claim/route.ts",
    "services/analyzer/liming_analyzer/model_calls.py",
    "services/analyzer/liming_analyzer/model_compat.py",
    "services/analyzer/liming_analyzer/canonical_transcript.py",
    "services/analyzer/liming_analyzer/canonical_review.py",
    "services/analyzer/liming_analyzer/content_module_protocol.py",
    "services/analyzer/liming_analyzer/unified_analysis.py",
    "services/analyzer/liming_analyzer/reviewed_analysis.py",
    "services/analyzer/liming_analyzer/minimax_vision.py",
    "services/analyzer/liming_analyzer/visual.py",
    "services/analyzer/liming_analyzer/content_analysis.py",
    "services/analyzer/liming_analyzer/content_report_contract.py", "lib/content-report-contract.ts",
    "services/analyzer/liming_analyzer/content_metrics.py",
    "services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json",
    "services/analyzer/liming_analyzer/resources/content-report-contract.v1.json",
    "lib/video-content-analysis.ts", "lib/analysis-quality.ts", "lib/analysis-profile.ts",
    "lib/material-analysis-state.ts",
    "lib/unified-report.ts", "lib/analysis-report-view.ts", "lib/analysis-module-retry.ts",
    "lib/analysis-media.ts", "lib/video-knowledge-atom-state.ts", "lib/script-rewrite.ts",
    "lib/content-production.ts", "lib/single-benchmark-rewrite.ts", "lib/project-assistant-benchmarks.ts",
    "app/api/topics/route.ts",
    "app/api/internal/analysis-jobs/[jobId]/complete/route.ts",
    "app/api/internal/analysis-jobs/[jobId]/model-calls/route.ts",
    "app/api/internal/analysis-jobs/[jobId]/artifacts/route.ts",
    "app/api/analysis-jobs/[jobId]/retry/route.ts",
    "app/api/videos/[videoId]/route.ts", "app/api/videos/[videoId]/media/route.ts",
    "app/api/video-library/[entryId]/media/route.ts", "app/api/video-library/content-comparison/route.ts",
    "components/AnalysisDetail.tsx", "components/UnifiedReportContent.tsx",

  ]) {
    hash.update(name + "\0");
    try { hash.update(readFileSync(path.join(root, name))); } catch (error) { if (error.code !== "ENOENT") throw error; hash.update("missing"); }
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[3] || fileURLToPath(new URL("..", import.meta.url));
  if (process.argv[2] === "--source-id") console.log(runtimeSourceId(root));
  else if (process.argv[2] === "--installation-id") console.log(runtimeInstallationId(root));
  else process.exitCode = 2;
}
