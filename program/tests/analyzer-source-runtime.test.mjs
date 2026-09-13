import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("both analyzer launchers select the delivered source before starting Python", () => {
  for (const name of ["start-analyzer.ps1", "run-analyzer-supervisor.ps1"]) {
    const source = readFileSync(path.join(root, "scripts", name), "utf8");
    assert.match(source, /analyzer-source-runtime\.ps1/);
    assert.match(source, /Set-AnalyzerSourceRuntime/);
    assert.ok(source.indexOf("Set-AnalyzerSourceRuntime") < source.indexOf("-m liming_analyzer"));
  }
});

test("source selection is idempotent and rejects incomplete delivery folders", { skip: process.platform !== "win32" }, () => {
  // Match the existing Windows .bat launchers' process-local script policy.
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:ANALYZER_TEST_ROOT 'scripts/analyzer-source-runtime.ps1')
    $env:PYTHONPATH = 'legacy-installed-package'
    $selected = Set-AnalyzerSourceRuntime $env:ANALYZER_TEST_ROOT
    $null = Set-AnalyzerSourceRuntime $env:ANALYZER_TEST_ROOT
    $rejected = $false
    try { $null = Set-AnalyzerSourceRuntime (Join-Path $env:ANALYZER_TEST_ROOT 'missing-source-fixture') } catch { $rejected = $true }
    [pscustomobject]@{ source = $selected; paths = @($env:PYTHONPATH -split ';'); rejected = $rejected } | ConvertTo-Json -Compress
  `], { env: { ...process.env, ANALYZER_TEST_ROOT: root }, encoding: "utf8", timeout: 10000 });
  const result = JSON.parse(output.trim());
  assert.equal(path.normalize(result.source), path.join(root, "services", "analyzer"));
  assert.deepEqual(result.paths, [result.source, "legacy-installed-package"]);
  assert.equal(result.rejected, true);
});
