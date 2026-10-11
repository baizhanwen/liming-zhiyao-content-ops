import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const parent = path.join(root, ".local/maintenance-tests"); mkdirSync(parent, { recursive: true });
  const installation = mkdtempSync(path.join(parent, "run-"));
  mkdirSync(path.join(installation, "scripts")); mkdirSync(path.join(installation, ".local"));
  for (const name of ["run-web-guard.ps1", "local-web-identity.ps1", "run-migration-guard.ps1", "run-local-migrations.mjs", "analyzer-instance-lock.ps1", "local-state-maintenance.ps1", "backup-local.ps1", "restore-local.ps1", "factory-reset.ps1", "start-lan.ps1", "verify-state-databases.mjs"]) copyFileSync(path.join(root, "scripts", name), path.join(installation, "scripts", name));
  for (const name of ["start-local.bat", "setup-local.bat"]) copyFileSync(path.join(root, name), path.join(installation, name));
  writeFileSync(path.join(installation, ".local/app.port"), "59998");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.Path = installation + path.delimiter + (process.env.Path || process.env.PATH || "");
  env.MAINT_TEST_INSTALL = installation;
  const run = (script, input = "") => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { cwd: installation, env, encoding: "utf8", input, windowsHide: true, timeout: 30000 });
  return { installation, env, run };
}
async function kill(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("close", resolve); killer.on("error", resolve); });
  for (let i = 0; i < 50 && child.exitCode === null; i++) await wait(100);
  assert.notEqual(child.exitCode, null, "Fixture owner did not terminate");
}

test("maintenance and official startup exclude each other before a server listens", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(); let owner;
  t.after(async () => { await kill(owner); });
  // The child does no application work; its live process holds the real named locks.
  writeFileSync(path.join(f.installation, "scripts/hold.ps1"), `param([string]$Purpose)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-state-maintenance.ps1')
$install = Split-Path $PSScriptRoot
if ($Purpose -eq 'maintenance') { $locks = @(Enter-LocalStateMaintenance $install) }
else { $locks = @(Enter-AnalyzerInstanceLock $install 'web') }
try {
    if ($null -eq $locks[0]) { throw 'Lock acquisition failed' }
    [IO.File]::WriteAllText((Join-Path $install '.local/ready'), 'ready')
    while (-not (Test-Path -LiteralPath (Join-Path $install '.local/release'))) { Start-Sleep -Milliseconds 50 }
} finally { Exit-LocalStateMaintenance $locks }
`);
  for (const purpose of ["maintenance", "web"]) {
    const { unlinkSync } = await import("node:fs");
    for (const name of ["ready", "release"]) { const file = path.join(f.installation, ".local", name); if (existsSync(file)) unlinkSync(file); }
    owner = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(f.installation, "scripts/hold.ps1"), "-Purpose", purpose], { cwd: f.installation, env: f.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; owner.stderr.on("data", data => { errors += data; });
    for (let i = 0; i < 100 && !existsSync(path.join(f.installation, ".local/ready")) && owner.exitCode === null; i++) await wait(50);
    assert.equal(owner.exitCode, null, errors); assert.ok(existsSync(path.join(f.installation, ".local/ready")));
    for (const command of [
      "& (Join-Path $env:MAINT_TEST_INSTALL 'start-local.bat')",
      "& (Join-Path $env:MAINT_TEST_INSTALL 'setup-local.bat')",
      "& (Join-Path $env:MAINT_TEST_INSTALL 'scripts/start-lan.ps1')",
      "& (Join-Path $env:MAINT_TEST_INSTALL 'scripts/backup-local.ps1')",
      "& (Join-Path $env:MAINT_TEST_INSTALL 'scripts/restore-local.ps1')",
      "& (Join-Path $env:MAINT_TEST_INSTALL 'scripts/factory-reset.ps1')",
    ]) {
      const result = f.run(command); assert.notEqual(result.status, 0, command); assert.match(result.stderr + result.stdout, /in progress|Stop the project first/);
      assert.ok(!existsSync(path.join(f.installation, ".dev.vars"))); assert.ok(!existsSync(path.join(f.installation, ".wrangler")), "Blocked command changed storage");
    }
    if (purpose === "maintenance") {
      const migration = spawnSync(process.execPath, [path.join(f.installation, "scripts/run-local-migrations.mjs")], { env: f.env, encoding: "utf8", timeout: 15000, windowsHide: true });
      assert.equal(migration.status, 1); assert.match(migration.stderr, /in progress/);
      assert.ok(!existsSync(path.join(f.installation, ".wrangler")), "Blocked migration changed storage");
    }
    // Abrupt termination abandons the mutex; stale records must not block recovery.
    await kill(owner); owner = null;
    const reacquired = f.run(". (Join-Path $env:MAINT_TEST_INSTALL 'scripts/local-state-maintenance.ps1'); $locks = @(Enter-LocalStateMaintenance $env:MAINT_TEST_INSTALL); Exit-LocalStateMaintenance $locks");
    assert.equal(reacquired.status, 0, reacquired.stderr);
  }
  // Exercise actual guard -> batch invocation with a harmless child and preserve its exit code.
  writeFileSync(path.join(f.installation, "start-local.bat"), '@echo off\r\nif not "%~1"=="--guarded" exit /b 9\r\necho launched>"%~dp0.local\\launched"\r\nexit /b 17\r\n');
  const result = f.run("& (Join-Path $env:MAINT_TEST_INSTALL 'scripts/run-web-guard.ps1') -Entry start-local; exit $LASTEXITCODE");
  assert.equal(result.status, 17, result.stderr); assert.ok(existsSync(path.join(f.installation, ".local/launched")));
  writeFileSync(path.join(f.installation, ".local/report.json"), JSON.stringify({ passed: true, synthetic: true, blockedCommands: 13, abandonedOwnersRecovered: 2, childExitCodePreserved: 17 }, null, 2));
});

test("failed factory reset preserves database, cookies, logs and the caller CI setting", { skip: process.platform !== "win32" }, () => {
  const f = fixture();
  const state = path.join(f.installation, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"); mkdirSync(state, { recursive: true });
  const database = path.join(state, "fixture.sqlite"); const db = new DatabaseSync(database); db.exec("CREATE TABLE business_data(id TEXT); INSERT INTO business_data VALUES ('keep');"); db.close();
  writeFileSync(path.join(f.installation, ".local/douyin-cookies.txt"), "synthetic private cookie"); mkdirSync(path.join(f.installation, ".local/logs")); writeFileSync(path.join(f.installation, ".local/logs/old.log"), "keep logs");
  writeFileSync(path.join(f.installation, ".dev.vars"), "SYNTHETIC_CONFIG=keep");
  writeFileSync(path.join(f.installation, "npm.cmd"), '@echo off\r\nmkdir "%~dp0.wrangler\\state"\r\necho failed>"%~dp0.wrangler\\state\\failed.txt"\r\nexit /b 19\r\n');
  const before = readFileSync(database);
  const result = f.run(`$env:CI = 'original-ci'
$rejected = $false
try { & (Join-Path $env:MAINT_TEST_INSTALL 'scripts/factory-reset.ps1') } catch { $rejected = $_.Exception.Message -match 'previous state restored' }
if (-not $rejected) { throw 'Failure injection did not run' }
if ($env:CI -ne 'original-ci') { throw 'Caller CI setting changed' }
`, "FACTORY RESET\n");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(readFileSync(database), before); assert.equal(readFileSync(path.join(f.installation, ".local/douyin-cookies.txt"), "utf8"), "synthetic private cookie"); assert.equal(readFileSync(path.join(f.installation, ".local/logs/old.log"), "utf8"), "keep logs"); assert.equal(readFileSync(path.join(f.installation, ".dev.vars"), "utf8"), "SYNTHETIC_CONFIG=keep");
  writeFileSync(path.join(f.installation, "npm.cmd"), '@echo off\r\nmkdir "%~dp0.wrangler\\state"\r\necho new>"%~dp0.wrangler\\state\\new.txt"\r\nexit /b 0\r\n');
  const cleanupFailure = f.run(`
function Move-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ([IO.Path]::GetFileName($LiteralPath) -eq 'logs' -and $Destination.Contains('private-reset-')) { throw 'Injected private cleanup failure' }
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
$rejected = $false
try { & (Join-Path $env:MAINT_TEST_INSTALL 'scripts/factory-reset.ps1') } catch { $rejected = $_.Exception.Message -match 'Injected private cleanup failure.*previous state restored' }
if (-not $rejected) { throw 'Cleanup failure injection did not run' }
`, "FACTORY RESET\n");
  assert.equal(cleanupFailure.status, 0, cleanupFailure.stderr || cleanupFailure.stdout);
  assert.deepEqual(readFileSync(database), before); assert.equal(readFileSync(path.join(f.installation, ".local/douyin-cookies.txt"), "utf8"), "synthetic private cookie"); assert.equal(readFileSync(path.join(f.installation, ".local/logs/old.log"), "utf8"), "keep logs");
  writeFileSync(path.join(f.installation, ".local/reset-report.json"), JSON.stringify({ passed: true, synthetic: true, migration: "injected exit 19", cleanupFailureRolledBack: true, databasePreserved: true, cookieAndLogsPreserved: true, ciPreserved: true }, null, 2));
});
