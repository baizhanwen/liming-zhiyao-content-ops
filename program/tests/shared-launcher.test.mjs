import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
function fixture(t) {
  const tempRoot = path.resolve(tmpdir()), dir = mkdtempSync(path.join(tempRoot, "liming shared launcher-"));
  t.after(() => {
    const relative = path.relative(tempRoot, path.resolve(dir));
    assert.ok(relative.startsWith("liming shared launcher-") && !relative.includes(path.sep) && !path.isAbsolute(relative));
    rmSync(dir, { recursive: true, force: true });
  });
  const scripts = path.join(dir, "scripts"); mkdirSync(scripts);
  for (const name of ["prepare-local-web.ps1", "open-web.ps1", "open-local.ps1", "open-lan.ps1"]) copyFileSync(path.join(root, "scripts", name), path.join(scripts, name));
  const run = (script, args = [], env = {}) => {
    // Windows treats PATH/Path as the same name; Node can otherwise retain the
    // inherited PATH and discard our fake-command directory when spawning.
    const runEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([key]) => key.toLowerCase() !== "path"));
    runEnv.Path = dir + path.delimiter + (process.env.Path || process.env.PATH || "");
    return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, script), ...args], { encoding: "utf8", timeout: 15000, windowsHide: true, env: runEnv });
  };
  return { dir, scripts, run };
}

test("shared startup checks dependencies and preserves existing local configuration", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  assert.equal(f.run("prepare-local-web.ps1", ["-CheckDependenciesOnly"]).status, 1);
  for (const relative of ["node_modules/wrangler/bin/wrangler.js", "node_modules/vinext/package.json"]) {
    const target = path.join(f.dir, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, "{}");
  }
  writeFileSync(path.join(f.dir, ".dev.vars.example"), "SYNTHETIC_TEST=1");
  const checked = f.run("prepare-local-web.ps1", ["-CheckDependenciesOnly"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(readFileSync(path.join(f.dir, ".dev.vars"), "utf8"), "SYNTHETIC_TEST=1");
  writeFileSync(path.join(f.dir, ".dev.vars"), "SYNTHETIC_TEST=preserve");
  assert.equal(f.run("prepare-local-web.ps1", ["-CheckDependenciesOnly"]).status, 0);
  assert.equal(readFileSync(path.join(f.dir, ".dev.vars"), "utf8"), "SYNTHETIC_TEST=preserve");
});

test("shared startup runs each preparation once and stops on migration failure", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  for (const relative of ["node_modules/wrangler/bin/wrangler.js", "node_modules/vinext/package.json"]) {
    const target = path.join(f.dir, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, "{}");
  }
  writeFileSync(path.join(f.dir, ".dev.vars"), "SYNTHETIC_TEST=1");
  writeFileSync(path.join(f.dir, "npm.cmd"), '@echo off\r\necho %2>>"%~dp0calls.txt"\r\nif "%2"=="%FAIL_STAGE%" exit /b 17\r\nexit /b 0\r\n');
  writeFileSync(path.join(f.scripts, "probe.ps1"), '& "$PSScriptRoot\\prepare-local-web.ps1"\n$resultCode = $LASTEXITCODE\n$env:CI | Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) "ci.txt")\nexit $resultCode\n');
  const success = f.run("probe.ps1", [], { CI: "original-ci", FAIL_STAGE: "" });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(readFileSync(path.join(f.dir, "calls.txt"), "utf8").trim().split(/\r?\n/), ["db:local:migrate", "auth:startup", "knowledge:local:sync"]);
  assert.equal(readFileSync(path.join(f.dir, "ci.txt"), "utf8").trim(), "original-ci");
  writeFileSync(path.join(f.dir, "calls.txt"), "");
  assert.equal(f.run("probe.ps1", [], { FAIL_STAGE: "db:local:migrate" }).status, 17);
  assert.equal(readFileSync(path.join(f.dir, "calls.txt"), "utf8").trim(), "db:local:migrate");
});

test("both browser launch wrappers use the shared health loop and the correct analyzer origin", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  writeFileSync(path.join(f.scripts, "start-analyzer-background.ps1"), 'param([string]$BaseUrl)\n$BaseUrl | Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) "analyzer.txt")\n');
  writeFileSync(path.join(f.scripts, "probe.ps1"), `param([string]$Mode)
$probeRoot = Split-Path $PSScriptRoot
function Invoke-WebRequest { param([switch]$UseBasicParsing, [string]$Uri, [int]$TimeoutSec) $Uri | Set-Content -LiteralPath (Join-Path $probeRoot "health.txt"); return @{ StatusCode = 200 } }
function Start-Process { param([string]$FilePath) $FilePath | Set-Content -LiteralPath (Join-Path $probeRoot "browser.txt") }
if ($Mode -eq "lan") { & "$PSScriptRoot\\open-lan.ps1" -Url "http://192.168.1.20:3100" -HealthUrl "http://127.0.0.1:3100" }
else { & "$PSScriptRoot\\open-local.ps1" -Url "http://127.0.0.1:3200" }
exit $LASTEXITCODE
`);
  for (const mode of ["local", "lan"]) {
    const result = f.run("probe.ps1", ["-Mode", mode]);
    assert.equal(result.status, 0, result.stderr);
    const origin = mode === "local" ? "http://127.0.0.1:3200" : "http://127.0.0.1:3100";
    assert.equal(readFileSync(path.join(f.dir, "health.txt"), "utf8").trim(), origin + "/api/health");
    assert.equal(readFileSync(path.join(f.dir, "analyzer.txt"), "utf8").trim(), origin);
    assert.ok(existsSync(path.join(f.dir, "browser.txt")));
    assert.equal(readFileSync(path.join(f.dir, "browser.txt"), "utf8").trim(), mode === "lan" ? "http://192.168.1.20:3100" : origin);
  }
});
