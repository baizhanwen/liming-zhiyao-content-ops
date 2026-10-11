import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { zipSync, unzipSync, strToU8 } from "fflate";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
test("shipped Windows backup/restore validates integrity and preserves state on failure", { skip: process.platform !== "win32" }, () => {
  const parent = path.join(root, ".local/backup-tests"); mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(path.join(parent, "run-"));
  const installation = path.join(fixture, "客户 install");
  const scripts = path.join(installation, "scripts"); mkdirSync(scripts, { recursive: true });
  for (const file of ["backup-local.ps1", "restore-local.ps1", "local-state-maintenance.ps1", "analyzer-instance-lock.ps1"]) cpSync(path.join(root, "scripts", file), path.join(scripts, file));
  const state = path.join(installation, ".wrangler/state");
  const database = path.join(state, "v3/d1/miniflare-D1DatabaseObject/fixture.sqlite"); mkdirSync(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES ('fixture', 'before backup');"); db.close();
  const media = path.join(state, "v3/r2/附件.bin"); mkdirSync(path.dirname(media), { recursive: true }); writeFileSync(media, Buffer.from([0, 1, 255, 42]));
  writeFileSync(path.join(state, ".hidden-file"), "hidden backup fixture");
  writeFileSync(path.join(installation, ".dev.vars"), "SYNTHETIC_SECRET=excluded");
  mkdirSync(path.join(installation, ".local")); writeFileSync(path.join(installation, ".local/app.port"), "59999");
  const run = (script, input = "", extra = {}) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: installation, env: { ...process.env, BACKUP_TEST_INSTALL: installation, BACKUP_TEST_RUN: fixture, ...extra },
    encoding: "utf8", input, windowsHide: true, timeout: 90000,
  });
  const logs = [];
  const success = (result) => { logs.push(result.stdout + result.stderr); assert.equal(result.status, 0, result.stderr || result.stdout); };
  success(run("& (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/backup-local.ps1')"));
  const backup = path.join(installation, "backups", readdirSync(path.join(installation, "backups")).find(name => name.endsWith(".zip")));
  const entries = unzipSync(readFileSync(backup));
  assert.ok(entries["state/.hidden-file"]); assert.ok(entries["state/v3/r2/附件.bin"]); assert.ok(!entries[".dev.vars"]);
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8")); assert.equal(manifest.formatVersion, 2); assert.equal(manifest.files.length, 3);
  writeFileSync(media, "changed after backup");
  const altered = new DatabaseSync(database); altered.exec("UPDATE projects SET name = 'after backup'"); altered.close();
  success(run("& (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/restore-local.ps1') -BackupPath $env:BACKUP_TEST_ZIP", "RESTORE\n", { BACKUP_TEST_ZIP: backup }));
  assert.deepEqual(readFileSync(media), Buffer.from([0, 1, 255, 42]));
  const restored = new DatabaseSync(database); assert.equal(restored.prepare("SELECT name FROM projects").get().name, "before backup"); assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); restored.close();
  const rollback = readdirSync(path.dirname(state)).find(name => name.startsWith("state-before-restore-"));
  assert.equal(readFileSync(path.join(path.dirname(state), rollback, "v3/r2/附件.bin"), "utf8"), "changed after backup");
  assert.equal(readFileSync(path.join(installation, ".dev.vars"), "utf8"), "SYNTHETIC_SECRET=excluded");

  const invalid = [];
  function invalidZip(name, edit) { const copy = Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value.slice()])); edit(copy); writeFileSync(path.join(fixture, name + ".zip"), zipSync(copy)); invalid.push(name); }
  invalidZip("bad-hash", copy => { copy["state/v3/r2/附件.bin"][0] = 44; });
  invalidZip("missing-file", copy => { delete copy["state/v3/r2/附件.bin"]; });
  invalidZip("extra-file", copy => { copy["state/unlisted.bin"] = strToU8("unlisted"); });
  invalidZip("traversal", copy => { copy["state/../../escape.txt"] = strToU8("escape"); });
  invalidZip("wrong-project", copy => { copy["manifest.json"] = strToU8(JSON.stringify({ ...manifest, project: "other" })); });
  invalidZip("wrong-version", copy => { copy["manifest.json"] = strToU8(JSON.stringify({ ...manifest, formatVersion: 99 })); });
  invalidZip("legacy", copy => { copy["manifest.json"] = strToU8(JSON.stringify({ project: "liming-zhiyao", formatVersion: 1 })); });
  invalidZip("empty-state", copy => { for (const key of Object.keys(copy)) if (key.startsWith("state/")) delete copy[key]; });
  writeFileSync(path.join(fixture, "truncated.zip"), readFileSync(backup).subarray(0, 50)); invalid.push("truncated");
  writeFileSync(path.join(fixture, "cases.json"), JSON.stringify(invalid));
  const baseline = readFileSync(database);
  // Test invalid archives through the exact shipped validator; none reaches state replacement.
  success(run(`
$ErrorActionPreference = 'Stop'
. (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/local-state-maintenance.ps1')
$cases = Get-Content -Raw (Join-Path $env:BACKUP_TEST_RUN 'cases.json') | ConvertFrom-Json
foreach ($name in $cases) {
    $destination = Join-Path $env:BACKUP_TEST_RUN ('extract-' + $name)
    New-Item -ItemType Directory $destination | Out-Null
    $rejected = $false
    try { Expand-CheckedStateArchive (Join-Path $env:BACKUP_TEST_RUN ($name + '.zip')) $destination } catch { $rejected = $true }
    if (-not $rejected) { throw "Invalid archive accepted: $name" }
}
Expand-CheckedStateArchive (Join-Path $env:BACKUP_TEST_RUN 'legacy.zip') (Join-Path $env:BACKUP_TEST_RUN 'legacy-allowed') -AllowLegacyBackup
# Locked state files must fail backup instead of producing a successful incomplete ZIP.
$locked = [IO.File]::Open((Join-Path $env:BACKUP_TEST_INSTALL '.wrangler/state/v3/r2/附件.bin'), 'Open', 'ReadWrite', 'None')
try {
    $rejected = $false
    try { Write-StateArchive (Join-Path $env:BACKUP_TEST_INSTALL '.wrangler/state') (Join-Path $env:BACKUP_TEST_RUN 'locked.zip') } catch { $rejected = $true }
    if (-not $rejected) { throw 'Locked state was accepted.' }
} finally { $locked.Dispose() }
`));
  assert.deepEqual(readFileSync(database), baseline);
  const failed = run("& (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/restore-local.ps1') -BackupPath $env:BACKUP_TEST_ZIP", "RESTORE\n", { BACKUP_TEST_ZIP: path.join(fixture, "bad-hash.zip") });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /checksum mismatch/); assert.deepEqual(readFileSync(database), baseline);
  assert.ok(!readdirSync(path.dirname(state)).some(name => name.startsWith("r-")));
  // Inject the final rename failure after the old state has already been moved.
  success(run(`
$ErrorActionPreference = 'Stop'
function Move-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ([IO.Path]::GetFileName([IO.Path]::GetDirectoryName($LiteralPath)).StartsWith('r-') -and [IO.Path]::GetFileName($LiteralPath) -eq 'state') { throw 'Injected replacement rename failure' }
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
$rejected = $false
try { & (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/restore-local.ps1') -BackupPath $env:BACKUP_TEST_ZIP } catch { Write-Host $_.Exception.Message; $rejected = $_.Exception.Message -match 'Injected replacement rename failure' }
if (-not $rejected) { throw 'Replacement failure injection did not run.' }
`, "RESTORE\n", { BACKUP_TEST_ZIP: backup }));
  assert.deepEqual(readFileSync(database), baseline);
  assert.deepEqual(readFileSync(media), Buffer.from([0, 1, 255, 42]));
  // Inspection failures and occupied ports must fail closed; stale PID records are irrelevant.
  success(run(`
$ErrorActionPreference = 'Stop'
. (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/local-state-maintenance.ps1')
function Get-NetTCPConnection { throw 'Injected inspection failure' }
$rejected = $false
try { Assert-LocalStateStopped $env:BACKUP_TEST_INSTALL } catch { $rejected = $_.Exception.Message -match 'Injected inspection failure' }
if (-not $rejected) { throw 'Inspection failure was ignored.' }
function Get-NetTCPConnection { [pscustomobject]@{ LocalPort = 59999 } }
$rejected = $false
try { Assert-LocalStateStopped $env:BACKUP_TEST_INSTALL } catch { $rejected = $_.Exception.Message -match 'port 59999 is listening' }
if (-not $rejected) { throw 'Listening port was ignored.' }
function Get-NetTCPConnection { @() }
function Get-CimInstance { [pscustomobject]@{ ProcessId = 999999; Name = 'powershell.exe'; CommandLine = (Join-Path $env:BACKUP_TEST_INSTALL 'scripts/run-analyzer-supervisor.ps1') } }
$rejected = $false
try { Assert-LocalStateStopped $env:BACKUP_TEST_INSTALL } catch { $rejected = $_.Exception.Message -match 'still running' }
if (-not $rejected) { throw 'Running analyzer was ignored.' }
`));
  writeFileSync(path.join(fixture, "verification.log"), logs.join("\n") + failed.stderr);
  writeFileSync(path.join(fixture, "report.json"), JSON.stringify({ passed: true, synthetic: true, installation, checkedFiles: 3, rejectedArchives: invalid, rollbackPreserved: true, failedRenameRecovered: true, stopGuardsVerified: true, secretsExcluded: true, boundary: "Actual shipped PowerShell scripts, SQLite and bytes; synthetic records. HTTP login/media recovery covered separately." }, null, 2));
});
