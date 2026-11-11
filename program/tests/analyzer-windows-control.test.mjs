import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, encoding: "utf8", timeout: 60_000, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function powershell(script, extraEnvironment = {}) {
  const result = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, ...extraEnvironment },
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
}

async function control(installation, action, baseUrl) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/analyzer-windows-control.ps1"), "-Action", action];
  if (baseUrl) args.push("-BaseUrl", baseUrl);
  const result = await execute("powershell.exe", args, { cwd: installation });
  const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1);
  assert.ok(lastLine, `Controller returned no JSON: ${result.stderr}`);
  const parsed = JSON.parse(lastLine);
  return { code: result.code, result: parsed.result ?? parsed, diagnostics: result.stderr };
}

function copyRuntime(installation) {
  mkdirSync(path.join(installation, "scripts"), { recursive: true });
  mkdirSync(path.join(installation, ".local"), { recursive: true });
  mkdirSync(path.join(installation, "services/analyzer/liming_analyzer"), { recursive: true });
  mkdirSync(path.join(installation, "services/analyzer/liming_analyzer/resources"), { recursive: true });
  copyFileSync(path.join(root, "services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json"), path.join(installation, "services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json"));
  for (const name of ["analyzer-windows-control.ps1", "analyzer-windows-identity.ps1", "run-analyzer-supervisor.ps1", "analyzer-instance-lock.ps1", "analyzer-source-runtime.ps1"]) {
    copyFileSync(path.join(root, "scripts", name), path.join(installation, "scripts", name));
  }
  // Deliberate dependency boundaries: no models, browser, media tools or network
  // are installed. The real controller, supervisor and native ownership checks run.
  writeFileSync(path.join(installation, "scripts/analyzer-media-runtime.ps1"), "function Import-AnalyzerMediaRuntime([string]$ProjectRoot) { return [pscustomobject]@{ Ffmpeg='fixture'; Ffprobe='fixture' } }\n");
  writeFileSync(path.join(installation, "scripts/analyzer-collector-runtime.ps1"), "function Import-AnalyzerCollectorRuntime { param([string]$ProjectRoot,[switch]$AllowUnavailable) return $null }\n");
}

const syntheticWorker = `import ctypes, json, os, pathlib, time
from ctypes import wintypes
root = pathlib.Path(__file__).resolve().parents[3]
marker = root / '.local/synthetic-worker.json'
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
kernel.WaitForSingleObject.restype = wintypes.DWORD
kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
parent = kernel.OpenProcess(0x100000, False, int(os.environ['ANALYZER_SUPERVISOR_PID']))
if not parent: raise RuntimeError('No synthetic supervisor handle')
marker.write_text(json.dumps({'pid':os.getpid()}), encoding='utf-8')
try:
    while kernel.WaitForSingleObject(parent, 0) == 258:
        os.utime(marker, None)
        time.sleep(.1)
finally:
    kernel.CloseHandle(parent)
    marker.unlink(missing_ok=True)
`;

async function fixture(t) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "lmzy-control-中文 目录-")));
  const installations = [path.join(directory, "app"), path.join(directory, "app-extra")];
  const workers = new Map();
  const web = createServer((request, response) => {
    const workerId = new URL(request.url, "http://127.0.0.1").searchParams.get("workerId");
    const installation = workers.get(workerId);
    let online = false;
    try { online = Date.now() - statSync(path.join(installation, ".local/synthetic-worker.json")).mtimeMs < 3_000; } catch { /* Worker has not started or has stopped. */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ online, lastSeenAt: online ? new Date().toISOString() : null }));
  });
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${web.address().port}`;
  t.after(async () => {
    try {
      for (const installation of installations) {
        if (existsSync(path.join(installation, "scripts/analyzer-windows-control.ps1"))) {
          const stopped = await control(installation, "stop", baseUrl);
          assert.equal(stopped.code, 0, JSON.stringify(stopped));
        }
      }
    } finally { await new Promise(resolve => web.close(resolve)); }
    // A legacy worker is deliberately terminated without executing its Python
    // finally block. Its marker can remain after exit; async removal retries
    // Windows directory locks while the owned processes finish closing.
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  for (const [index, installation] of installations.entries()) {
    copyRuntime(installation);
    const initialized = await execute(process.env.ANALYZER_RUNTIME_TEST_PYTHON || "python", ["-m", "venv", "--without-pip", path.join(installation, "services/analyzer/.venv")]);
    assert.equal(initialized.code, 0, initialized.stderr);
    writeFileSync(path.join(installation, "services/analyzer/liming_analyzer/__init__.py"), "");
    writeFileSync(path.join(installation, "services/analyzer/liming_analyzer/__main__.py"), syntheticWorker);
    const workerId = `synthetic-fixture-${index}`;
    workers.set(workerId, installation);
    writeFileSync(path.join(installation, ".dev.vars"), `ANALYZER_BASE_URL=${baseUrl}\nANALYZER_SERVICE_TOKEN=synthetic-fixture-service-token\nANALYZER_WORKER_ID=${workerId}\n`);
  }
  return { directory, installations, baseUrl };
}

test("the full package contains the shared Windows service controller and ownership helper", () => {
  const policy = JSON.parse(readFileSync(path.join(root, "resources/delivery/runtime-scripts.json"), "utf8"));
  for (const script of ["analyzer-windows-control.ps1", "analyzer-windows-identity.ps1"]) {
    assert.ok(policy.videoAnalysis.includes(script), `Video-analysis delivery omits ${script}`);
    assert.ok(existsSync(path.join(root, "scripts", script)), `Missing approved runtime script ${script}`);
  }
});

test("Windows source signatures include empty files and content without optional hashing cmdlets", { skip: !windows }, async t => {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "lmzy-signature-中文 目录-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyRuntime(directory);
  const source = path.join(directory, "services/analyzer/liming_analyzer");
  writeFileSync(path.join(source, "__init__.py"), "");
  writeFileSync(path.join(source, "__main__.py"), "# synthetic source\n");
  const result = await powershell(`
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:OWNERSHIP_ROOT 'scripts/analyzer-windows-identity.ps1')
    function Get-FileHash { throw 'Optional hashing cmdlet must not be needed during startup.' }
    $first = Get-AnalyzerSourceSignature $env:OWNERSHIP_ROOT
    $same = Get-AnalyzerSourceSignature $env:OWNERSHIP_ROOT
    [IO.File]::AppendAllText((Join-Path $env:OWNERSHIP_ROOT 'services/analyzer/liming_analyzer/__main__.py'), '# upgraded source')
    $changed = Get-AnalyzerSourceSignature $env:OWNERSHIP_ROOT
    [IO.File]::Delete((Join-Path $env:OWNERSHIP_ROOT 'services/analyzer/liming_analyzer/__init__.py'))
    $removed = Get-AnalyzerSourceSignature $env:OWNERSHIP_ROOT
    [IO.File]::AppendAllText((Join-Path $env:OWNERSHIP_ROOT 'services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json'), ' ')
    $taxonomyChanged = Get-AnalyzerSourceSignature $env:OWNERSHIP_ROOT
    [pscustomobject]@{ valid=($first -match '^[a-f0-9]{64}$'); stable=($first -eq $same); contentChanges=($first -ne $changed); emptyFilesIncluded=($changed -ne $removed); taxonomyIncluded=($removed -ne $taxonomyChanged) } | ConvertTo-Json -Compress
  `, { OWNERSHIP_ROOT: directory });
  assert.deepEqual(result, { valid: true, stable: true, contentChanges: true, emptyFilesIncluded: true, taxonomyIncluded: true });
});

test("Windows service start is idempotent, detects upgraded source, and stops its supervised worker", { skip: !windows, timeout: 240_000 }, async t => {
  const { installations: [installation], baseUrl } = await fixture(t);
  const started = await control(installation, "start", baseUrl);
  assert.equal(started.code, 0, JSON.stringify(started));
  assert.equal(started.result.workerRunning, true);
  const ownerPath = path.join(installation, ".local/analyzer-windows.json");
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  const repeated = await control(installation, "start", baseUrl);
  assert.equal(repeated.code, 0, JSON.stringify(repeated));
  assert.equal(JSON.parse(readFileSync(ownerPath, "utf8")).pid, owner.pid, "A second supervisor was started");
  const originalOwner = readFileSync(ownerPath, "utf8");
  rmSync(ownerPath);
  const legacy = await control(installation, "status", baseUrl);
  assert.equal(legacy.result.workerRunning, true, JSON.stringify(legacy));
  assert.equal(legacy.result.restartRequired, true, "Legacy PID records must not claim to have loaded current source");
  writeFileSync(ownerPath, originalOwner);
  const source = path.join(installation, "services/analyzer/liming_analyzer/__main__.py");
  writeFileSync(source, syntheticWorker + "\n# synthetic upgrade changes source signature\n");
  const changed = await control(installation, "status", baseUrl);
  assert.equal(changed.result.restartRequired, true, JSON.stringify(changed));
  assert.equal(changed.result.processRunning, true);
  const stopped = await control(installation, "stop", baseUrl);
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  for (let attempt = 0; attempt < 100 && existsSync(path.join(installation, ".local/synthetic-worker.json")); attempt++) await pause(50);
  assert.equal(existsSync(path.join(installation, ".local/synthetic-worker.json")), false, "Stopping the supervisor left its worker alive");
  const status = await control(installation, "status", baseUrl);
  assert.equal(status.result.processRunning, false);
  assert.equal(status.result.workerRunning, false);
});

test("Windows stop adopts a verified legacy venv worker and closes both redirector and real interpreter", { skip: !windows, timeout: 240_000 }, async t => {
  const { installations: [installation], baseUrl } = await fixture(t);
  const python = path.join(installation, "services/analyzer/.venv/Scripts/python.exe");
  const child = spawn(python, ["-m", "liming_analyzer"], {
    cwd: installation, windowsHide: true, stdio: "ignore",
    env: { ...process.env, PYTHONPATH: path.join(installation, "services/analyzer"), ANALYZER_SUPERVISOR_PID: String(process.pid) },
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const marker = path.join(installation, ".local/synthetic-worker.json");
  for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await pause(50);
  assert.ok(existsSync(marker), "The synthetic legacy worker did not start");
  const workerId = JSON.parse(readFileSync(marker, "utf8")).pid;
  writeFileSync(path.join(installation, ".local/analyzer-local.json"), JSON.stringify({ pid: child.pid, project: installation }));
  const identity = await powershell(`
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:OWNERSHIP_ROOT 'scripts/analyzer-windows-identity.ps1')
    Initialize-AnalyzerProcessApi
    $owned = New-Object LimingAnalyzer.OwnedProcess ([int]$env:OWNERSHIP_PID)
    try { [pscustomobject]@{ creationTime=$owned.CreationTime } | ConvertTo-Json -Compress } finally { $owned.Dispose() }
  `, { OWNERSHIP_ROOT: installation, OWNERSHIP_PID: String(workerId) });
  const stopped = await control(installation, "stop", baseUrl);
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  const remaining = await powershell(`
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:OWNERSHIP_ROOT 'scripts/analyzer-windows-identity.ps1')
    Initialize-AnalyzerProcessApi
    $owned = $null; $stillRunning = $false
    try {
      $owned = New-Object LimingAnalyzer.OwnedProcess ([int]$env:OWNERSHIP_PID)
      $stillRunning = $owned.Running -and $owned.CreationTime -eq $env:OWNERSHIP_CREATED
    } catch { } finally { if ($null -ne $owned) { $owned.Dispose() } }
    [pscustomobject]@{ stillRunning=$stillRunning } | ConvertTo-Json -Compress
  `, { OWNERSHIP_ROOT: installation, OWNERSHIP_PID: String(workerId), OWNERSHIP_CREATED: identity.creationTime });
  assert.equal(remaining.stillRunning, false, "The legacy venv redirector exited but its actual interpreter survived");
  for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) await pause(30);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "The legacy launcher survived stop");
});

test("Windows control keeps similar installation paths independent", { skip: !windows, timeout: 240_000 }, async t => {
  const { installations: [first, second], baseUrl } = await fixture(t);
  for (const [index, installation] of [first, second].entries()) {
    if (process.env.CI) console.error(`Synthetic service isolation: starting installation ${index + 1}`);
    const started = await control(installation, "start", baseUrl);
    assert.equal(started.code, 0, JSON.stringify(started));
  }
  const firstOwner = JSON.parse(readFileSync(path.join(first, ".local/analyzer-windows.json"), "utf8"));
  const secondOwner = JSON.parse(readFileSync(path.join(second, ".local/analyzer-windows.json"), "utf8"));
  assert.notEqual(firstOwner.pid, secondOwner.pid);
  if (process.env.CI) console.error("Synthetic service isolation: stopping the first installation");
  const stopped = await control(first, "stop", baseUrl);
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  if (process.env.CI) console.error("Synthetic service isolation: verifying the surviving installation");
  const surviving = await control(second, "status", baseUrl);
  assert.equal(surviving.result.processRunning, true, JSON.stringify(surviving));
  assert.equal(surviving.result.workerRunning, true);
  if (process.env.CI) console.error("Synthetic service isolation: survivor verified; cleaning up fixture processes");
});

test("Windows process ownership rejects a recycled creation time and foreign command path without stopping either process", { skip: !windows, timeout: 90_000 }, async t => {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "lmzy-owner-中文 目录-")));
  const first = path.join(directory, "app");
  const second = path.join(directory, "app-extra");
  for (const installation of [first, second]) copyRuntime(installation);
  const supervisorPath = path.join(first, "scripts/run-analyzer-supervisor.ps1");
  writeFileSync(supervisorPath, "while ($true) { Start-Sleep -Milliseconds 200 }\n");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisorPath], { windowsHide: true, stdio: "ignore" });
  t.after(async () => {
    child.kill();
    for (let attempt = 0; attempt < 100 && child.exitCode === null && child.signalCode === null; attempt++) await pause(30);
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const result = await powershell(`
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:OWNERSHIP_ROOT 'scripts/analyzer-windows-identity.ps1')
    $record = [pscustomobject]@{ pid=[int]$env:OWNERSHIP_PID; creationTime=''; project=$env:OWNERSHIP_ROOT }
    $owned = Get-AnalyzerOwnedProcess $env:OWNERSHIP_ROOT $record
    if ($null -eq $owned) { throw 'The known fixture supervisor was not recognized.' }
    $record.creationTime = ([long]$owned.creationTime + 10000000).ToString()
    $stale = Get-AnalyzerOwnedProcess $env:OWNERSHIP_ROOT $record
    $record.creationTime = $owned.creationTime
    $foreign = Get-AnalyzerOwnedProcess $env:OWNERSHIP_OTHER $record
    $owned.native.Dispose()
    [pscustomobject]@{ staleRejected=($null -eq $stale); foreignRejected=($null -eq $foreign) } | ConvertTo-Json -Compress
  `, { OWNERSHIP_ROOT: first, OWNERSHIP_OTHER: second, OWNERSHIP_PID: String(child.pid) });
  assert.deepEqual(result, { staleRejected: true, foreignRejected: true });
  writeFileSync(path.join(first, ".local/analyzer-windows.json"), JSON.stringify({ pid: child.pid, creationTime: "1", project: first }));
  const stopped = await control(first, "stop", "http://127.0.0.1:1");
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  assert.equal(child.exitCode, null, "An ownership status query terminated the fixture supervisor");
  assert.equal(child.signalCode, null);
});
