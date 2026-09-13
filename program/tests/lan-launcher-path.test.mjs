import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("LAN helper actually starts from an installation path containing spaces", { skip: process.platform !== "win32" }, () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const probes = path.join(root, ".local/launcher-tests");
  mkdirSync(probes, { recursive: true });
  const probeRoot = mkdtempSync(path.join(probes, "path with spaces-"));
  writeFileSync(path.join(probeRoot, "open-lan.ps1"), 'param([string]$Url, [string]$HealthUrl)\n@{ url=$Url; health=$HealthUrl } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot "started.json")\n');
  // Execute only the actual launch statement, with a harmless helper. The web
  // application, browser and real analyzer are never started by this test.
  const probe = `param([string]$Source, [string]$ProbeRoot)
$ErrorActionPreference = "Stop"
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "LAN launcher parse failed" }
$command = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq "Start-Process" }, $true)
$probeScriptRoot = $ProbeRoot
$env:LAN_ACCESS_ORIGIN = "http://127.0.0.1:31999"
$hostUrl = "http://127.0.0.1:31998"
Invoke-Expression ($command.Extent.Text.Replace('$PSScriptRoot', '$probeScriptRoot'))
for ($attempt=0; $attempt -lt 50; $attempt++) {
  if (Test-Path -LiteralPath (Join-Path $ProbeRoot "started.json")) { exit 0 }
  Start-Sleep -Milliseconds 100
}
throw "LAN helper did not start from the path containing spaces"
`;
  const probePath = path.join(probeRoot, "probe.ps1");
  writeFileSync(probePath, probe);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probePath, "-Source", path.join(root, "scripts/start-lan.ps1"), "-ProbeRoot", probeRoot], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(readFileSync(path.join(probeRoot, "started.json"), "utf8").replace(/^\uFEFF/, ""));
  assert.deepEqual(output, { url: "http://127.0.0.1:31999", health: "http://127.0.0.1:31998" });
});

test("overlong Windows installations stop with an actionable database path error", { skip: process.platform !== "win32" }, () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const probes = path.join(root, ".local/launcher-tests");
  mkdirSync(probes, { recursive: true });
  const probeRoot = mkdtempSync(path.join(probes, "long-path-"));
  const scriptDir = path.join(probeRoot, "x".repeat(80), "scripts");
  mkdirSync(scriptDir, { recursive: true });
  const script = path.join(scriptDir, "run-local-migrations.mjs");
  writeFileSync(script, readFileSync(path.join(root, "scripts/run-local-migrations.mjs")));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installation path is too long for the local database/);
  assert.doesNotMatch(result.stderr, /SQLITE_CANTOPEN|Cannot find module/);
});
