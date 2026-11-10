import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const collector = path.join(root, "services/analyzer/liming_analyzer/douyin_collector");
const nodeDirectory = path.join(collector, "node");

test("the collector ships its own locked runtime and provenance without the source project", () => {
  const manifest = JSON.parse(readFileSync(path.join(nodeDirectory, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(nodeDirectory, "package-lock.json"), "utf8"));
  const version = manifest.dependencies["@playwright/test"];
  assert.equal(version, "1.64.1");
  assert.equal(lock.packages[""].dependencies["@playwright/test"], version);
  assert.equal(lock.packages["node_modules/@playwright/test"].version, version);
  for (const file of ["adapter.py", "SOURCE.json", "LICENSES/skill-collect-MIT.txt", "node/capture-douyin.mjs"]) {
    assert.ok(existsSync(path.join(collector, file)), `Missing collector runtime resource: ${file}`);
  }
  const delivery = readFileSync(path.join(root, "scripts/prepare-delivery.ps1"), "utf8");
  assert.ok(delivery.includes('"services",'), "Delivery must include the analyzer package");
  assert.ok(delivery.includes('"services\\analyzer\\liming_analyzer\\douyin_collector\\node\\node_modules"'), "Installed collector dependencies must be excluded from source delivery");
  assert.ok(delivery.includes('"services\\analyzer\\build"'), "Wheel build caches must be excluded from source delivery");
  assert.ok(delivery.includes('"scripts\\install-collector.ps1"'), "Plans without video analysis must remove the collector installer");
});

test("Windows runtime selection isolates browser cache and keeps upload analysis available when collection is missing", { skip: process.platform !== "win32" }, () => {
  // Windows runner TEMP can use an 8.3 profile alias (RUNNER~1), while
  // PowerShell expands it to the long path. Native realpath also resolves 8.3
  // aliases, which the JavaScript realpath implementation can retain.
  const temporary = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "liming-collector-runtime-")));
  try {
    const fixture = path.join(temporary, "services/analyzer/liming_analyzer/douyin_collector/node");
    mkdirSync(fixture, { recursive: true });
    mkdirSync(path.join(temporary, ".local"));
    writeFileSync(path.join(temporary, ".local/node.path"), path.dirname(process.execPath));
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ dependencies: { "@playwright/test": "1.64.1" } }));
    writeFileSync(path.join(fixture, "package-lock.json"), "{}");
    // This fixture exercises launcher behavior; it is not a Chromium or public
    // video acceptance test. The real browser is checked by --doctor on install.
    writeFileSync(path.join(fixture, "capture-douyin.mjs"), "process.stdout.write(JSON.stringify({ok:true,playwright_version:'1.64.1'}));");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `
      $ErrorActionPreference = 'Stop'
      $WarningPreference = 'SilentlyContinue'
      . (Join-Path $env:ANALYZER_TEST_ROOT 'scripts/analyzer-media-runtime.ps1')
      . (Join-Path $env:ANALYZER_TEST_ROOT 'scripts/analyzer-collector-runtime.ps1')
      $env:PLAYWRIGHT_BROWSERS_PATH = 'another-project-browser-cache'
      $selected = @(Import-AnalyzerCollectorRuntime $env:ANALYZER_COLLECTOR_FIXTURE)
      Remove-Item -LiteralPath $selected[0].Script
      $soft = Import-AnalyzerCollectorRuntime $env:ANALYZER_COLLECTOR_FIXTURE -AllowUnavailable
      $strictRejected = $false
      try { $null = Import-AnalyzerCollectorRuntime $env:ANALYZER_COLLECTOR_FIXTURE } catch { $strictRejected = $true }
      [pscustomobject]@{
        count = $selected.Count; node = $selected[0].Node; cache = $env:PLAYWRIGHT_BROWSERS_PATH
        pathFirst = ($env:Path -split ';')[0]; uploadAvailable = ($null -eq $soft); strictRejected = $strictRejected
      } | ConvertTo-Json -Compress
    `], { env: { ...process.env, ANALYZER_TEST_ROOT: root, ANALYZER_COLLECTOR_FIXTURE: temporary }, encoding: "utf8", timeout: 20_000 });
    const result = JSON.parse(output.trim());
    assert.equal(result.count, 1, "Runtime checks must not leak extra stdout into the returned object");
    assert.equal(path.normalize(result.node), path.normalize(process.execPath));
    assert.equal(path.normalize(result.pathFirst), path.dirname(process.execPath));
    assert.equal(path.normalize(result.cache), path.join(temporary, ".local/collector-browsers"));
    assert.equal(result.uploadAvailable, true);
    assert.equal(result.strictRejected, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
