import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const packageName = "node-v22.23.2-win-x64";

function fixture(t) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "lmzy-node-中文 目录-")));
  const installation = path.join(directory, "app");
  mkdirSync(path.join(installation, "scripts"), { recursive: true });
  for (const name of ["install-node22.ps1", "node-runtime-policy.mjs"]) {
    copyFileSync(path.join(root, "scripts", name), path.join(installation, "scripts", name));
  }
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { directory, installation };
}

function writeArchive(directory, entries) {
  const archive = path.join(directory, "synthetic-node.zip");
  writeFileSync(archive, zipSync(Object.fromEntries(Object.entries(entries).map(([name, content]) => [name, strToU8(content)]))));
  return archive;
}

async function powershell(installation, script, environment = {}, timeout = 60_000) {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    . (Join-Path $env:NODE_FIXTURE_ROOT 'scripts/install-node22.ps1')
    ${script}
  `;
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
  const result = await new Promise((resolve, reject) => {
    execFile("powershell.exe", args, { windowsHide: true, encoding: "utf8", timeout, env: { ...process.env, NODE_FIXTURE_ROOT: installation, ...environment } }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`PowerShell fixture failed (${error.code}): ${stderr}\n${stdout}`)); return; }
      resolve(stdout);
    });
  });
  return JSON.parse(result.trim().split(/\r?\n/u).at(-1));
}

test("portable Node runtime and shared compatibility policy are shipped together", () => {
  const policy = JSON.parse(readFileSync(path.join(root, "resources/delivery/runtime-scripts.json"), "utf8"));
  assert.ok(policy.common.includes("install-node22.ps1"));
  assert.ok(policy.common.includes("node-runtime-policy.mjs"));
});

test("Windows runtime selection skips a rejected record and another installation's portable cache", { skip: !windows }, async t => {
  const { directory, installation } = fixture(t);
  const rejected = path.join(directory, "old Node 24.19");
  const system = path.join(directory, "system Node 中文");
  const portable = path.join(installation, ".local/node-runtime", packageName);
  const foreign = path.join(directory, "app-extra/.local/node-runtime", packageName);
  for (const location of [rejected, system, portable, foreign]) {
    mkdirSync(location, { recursive: true });
    writeFileSync(path.join(location, "node.exe"), "untouched fixture executable");
  }
  const record = path.join(installation, ".local/node.path");
  writeFileSync(record, `${rejected}\n`);
  const result = await powershell(installation, `
    $script:visited = New-Object System.Collections.Generic.List[string]
    $script:accepted = $env:NODE_FIXTURE_SYSTEM
    $env:ProgramFiles = Split-Path -Parent (Split-Path -Parent $env:NODE_FIXTURE_SYSTEM)
    function Test-NodeRuntime([string]$NodeExe, [string]$ExpectedVersion = '', [switch]$RequirePublisher) {
      $script:visited.Add($NodeExe)
      return $NodeExe -eq $script:accepted
    }
    function Get-Command { [pscustomobject]@{ Source=$env:NODE_FIXTURE_SYSTEM } }
    $first = Find-NodeRuntime (Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path') -OfflineCheck
    $firstVisited = @($script:visited)
    $script:visited.Clear()
    [IO.File]::WriteAllText((Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path'), $env:NODE_FIXTURE_FOREIGN, (New-Object Text.UTF8Encoding($false)))
    $script:accepted = $env:NODE_FIXTURE_PORTABLE
    $second = Find-NodeRuntime (Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path') -OfflineCheck
    [pscustomobject]@{ first=$first; firstVisited=$firstVisited; second=$second; secondVisited=@($script:visited) } | ConvertTo-Json -Compress -Depth 4
  `, {
    NODE_FIXTURE_SYSTEM: path.join(system, "node.exe"), NODE_FIXTURE_FOREIGN: foreign, NODE_FIXTURE_PORTABLE: path.join(portable, "node.exe"),
  });
  assert.equal(result.first, path.join(system, "node.exe"));
  assert.equal(result.firstVisited[0], path.join(rejected, "node.exe"));
  assert.equal(result.second, path.join(portable, "node.exe"));
  assert.ok(!result.secondVisited.includes(path.join(foreign, "node.exe")));
  for (const location of [rejected, system, foreign]) assert.equal(readFileSync(path.join(location, "node.exe"), "utf8"), "untouched fixture executable");
});

test("Windows runtime validation executes the shared policy and the selected runtime's npm", { skip: !windows }, async t => {
  const { directory, installation } = fixture(t);
  const incomplete = path.join(directory, "incomplete runtime/node.exe");
  mkdirSync(path.dirname(incomplete), { recursive: true });
  writeFileSync(incomplete, "must not be executed without npm");
  const result = await powershell(installation, `
    $supported = Test-NodeRuntime $env:NODE_FIXTURE_REAL_NODE -ExpectedVersion $env:NODE_FIXTURE_REAL_VERSION
    $wrongVersion = Test-NodeRuntime $env:NODE_FIXTURE_REAL_NODE -ExpectedVersion '0.0.0'
    $missingNpm = Test-NodeRuntime $env:NODE_FIXTURE_INCOMPLETE
    [pscustomobject]@{ supported=$supported; wrongVersion=$wrongVersion; missingNpm=$missingNpm } | ConvertTo-Json -Compress
  `, { NODE_FIXTURE_REAL_NODE: process.execPath, NODE_FIXTURE_REAL_VERSION: process.versions.node, NODE_FIXTURE_INCOMPLETE: incomplete });
  assert.deepEqual(result, { supported: true, wrongVersion: false, missingNpm: false });
});

test("Windows CheckOnly never downloads or writes and setup saves an existing compatible runtime as UTF8", { skip: !windows }, async t => {
  const { directory, installation } = fixture(t);
  const system = path.join(directory, "系统 Node 保留/node.exe");
  mkdirSync(path.dirname(system), { recursive: true });
  writeFileSync(system, "existing Node is preserved");
  const result = await powershell(installation, `
    function Find-NodeRuntime([string]$PathFile, [switch]$OfflineCheck) { return $env:NODE_FIXTURE_SYSTEM }
    function Download-NodeArchive { throw 'CheckOnly must not download.' }
    function Install-PortableNode { throw 'An existing supported runtime must not be replaced.' }
    $pathFile = Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path'
    $null = Invoke-NodeRuntimeSetup -PathFile $pathFile -OnlyCheck
    $untouched = -not (Test-Path -LiteralPath (Join-Path $env:NODE_FIXTURE_ROOT '.local'))
    $null = Invoke-NodeRuntimeSetup -PathFile $pathFile
    $bytes = [IO.File]::ReadAllBytes($pathFile)
    $saved = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes).Trim()
    $before = [Convert]::ToBase64String($bytes)
    $null = Invoke-NodeRuntimeSetup -PathFile $pathFile -OnlyCheck
    $same = $before -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($pathFile))
    function Find-NodeRuntime { return $null }
    $rejected = $false
    try { $null = Invoke-NodeRuntimeSetup -PathFile $pathFile -OnlyCheck } catch { $rejected = $true }
    [pscustomobject]@{ untouched=$untouched; saved=$saved; noBom=($bytes[0] -ne 239); same=$same; rejected=$rejected } | ConvertTo-Json -Compress
  `, { NODE_FIXTURE_SYSTEM: system });
  assert.deepEqual(result, { untouched: true, saved: path.dirname(system), noBom: true, same: true, rejected: true });
  assert.equal(readFileSync(system, "utf8"), "existing Node is preserved");
});

test("Windows portable install validates ZIP integrity and publisher before publishing inside its own directory", { skip: !windows }, async t => {
  const { directory, installation } = fixture(t);
  const archive = writeArchive(directory, {
    [`${packageName}/node.exe`]: "synthetic executable, never executed",
    [`${packageName}/npm.cmd`]: "@echo off\r\n",
    [`${packageName}/node_modules/npm/bin/npm-cli.js`]: "// synthetic npm\n",
  });
  const otherNode = path.join(directory, "other Node/node.exe");
  mkdirSync(path.dirname(otherNode), { recursive: true });
  writeFileSync(otherNode, "preserve globally installed Node");
  const result = await powershell(installation, `
    $script:downloads = New-Object System.Collections.Generic.List[string]
    $script:publisherStatus = 'NotSigned'
    $script:publisherName = 'CN=OpenJS Foundation, O=OpenJS Foundation'
    $script:runtimeChecks = 0
    function Download-NodeArchive([string]$Uri, [string]$Destination) {
      if ($Uri -ne 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip' -or -not (Test-NodePathWithin $Destination (Join-Path $env:NODE_FIXTURE_ROOT '.local/node-runtime'))) { throw 'Download escaped the project cache.' }
      $script:downloads.Add($Destination)
      Copy-Item -LiteralPath $env:NODE_FIXTURE_ARCHIVE -Destination $Destination
    }
    function Get-AuthenticodeSignature { [pscustomobject]@{ Status=$script:publisherStatus; SignerCertificate=[pscustomobject]@{ Subject=$script:publisherName } } }
    function Test-NodeRuntime([string]$NodeExe, [string]$ExpectedVersion = '', [switch]$RequirePublisher) {
      $script:runtimeChecks++
      return $ExpectedVersion -eq '22.23.2' -and (Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $NodeExe) 'node_modules/npm/bin/npm-cli.js'))
    }
    $hash = Get-NodeArchiveHash $env:NODE_FIXTURE_ARCHIVE
    $hashRejected = $false
    try { $null = Install-PortableNode '22.23.2' ('0' * 64) } catch { $hashRejected = $_.Exception.Message -match 'SHA256' }
    $signatureRejected = $false
    try { $null = Install-PortableNode '22.23.2' $hash } catch { $signatureRejected = $_.Exception.Message -match 'publisher signature' }
    $unsignedNotExecuted = $script:runtimeChecks -eq 0
    $script:publisherStatus = 'Valid'; $script:publisherName = 'CN=Different Publisher, O=Different Publisher'
    $publisherRejected = $false
    try { $null = Install-PortableNode '22.23.2' $hash } catch { $publisherRejected = $_.Exception.Message -match 'publisher signature' }
    $unpublished = -not (Test-Path -LiteralPath (Join-Path $env:NODE_FIXTURE_ROOT '.local/node-runtime/node-v22.23.2-win-x64'))
    $script:publisherName = 'CN=OpenJS Foundation, O=OpenJS Foundation'
    $installed = Install-PortableNode '22.23.2' $hash
    Save-NodePath $installed (Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path')
    $leftovers = @(Get-ChildItem -LiteralPath (Join-Path $env:NODE_FIXTURE_ROOT '.local/node-runtime') -Directory -Filter '.prepare-*').Count
    [pscustomobject]@{ hashRejected=$hashRejected; signatureRejected=$signatureRejected; publisherRejected=$publisherRejected; unsignedNotExecuted=$unsignedNotExecuted; unpublished=$unpublished; installed=$installed; runtimeChecks=$script:runtimeChecks; leftovers=$leftovers; downloads=$script:downloads.Count } | ConvertTo-Json -Compress
  `, { NODE_FIXTURE_ARCHIVE: archive });
  assert.deepEqual(result, {
    hashRejected: true, signatureRejected: true, publisherRejected: true, unsignedNotExecuted: true, unpublished: true,
    installed: path.join(installation, ".local/node-runtime", packageName, "node.exe"), runtimeChecks: 1, leftovers: 0, downloads: 4,
  });
  assert.equal(readFileSync(otherNode, "utf8"), "preserve globally installed Node");
  assert.equal(readFileSync(path.join(installation, ".local/node.path"), "utf8").trim(), path.join(installation, ".local/node-runtime", packageName));
});

test("Windows ZIP extraction rejects traversal before extracting even a safe first entry", { skip: !windows }, async t => {
  const { directory, installation } = fixture(t);
  const archive = writeArchive(directory, {
    [`${packageName}/node.exe`]: "must not be extracted before all paths pass",
    [`${packageName}/../../escaped.txt`]: "unsafe",
  });
  const extraction = path.join(installation, "extraction");
  const result = await powershell(installation, `
    $rejected = $false
    try { Expand-NodeArchive $env:NODE_FIXTURE_ARCHIVE $env:NODE_FIXTURE_EXTRACTION 'node-v22.23.2-win-x64' } catch { $rejected = $true }
    [pscustomobject]@{ rejected=$rejected; nothingExtracted=(-not (Test-Path -LiteralPath $env:NODE_FIXTURE_EXTRACTION)) } | ConvertTo-Json -Compress
  `, { NODE_FIXTURE_ARCHIVE: archive, NODE_FIXTURE_EXTRACTION: extraction });
  assert.deepEqual(result, { rejected: true, nothingExtracted: true });
  assert.ok(!existsSync(path.join(installation, "escaped.txt")));
});

test("Windows official portable Node ZIP installs with its real signature and remains unchanged during CheckOnly", {
  skip: !windows || process.env.LMZY_VERIFY_OFFICIAL_NODE !== "1",
  timeout: 180_000,
}, async t => {
  const { installation } = fixture(t);
  const result = await powershell(installation, `
    $finder = (Get-Item Function:Find-NodeRuntime).ScriptBlock
    function Find-NodeRuntime { return $null }
    $pathFile = Join-Path $env:NODE_FIXTURE_ROOT '.local/node.path'
    $installed = Invoke-NodeRuntimeSetup -PathFile $pathFile
    Set-Item -LiteralPath Function:Find-NodeRuntime -Value $finder
    $publisher = Test-NodePublisher $installed
    $runtime = (& $installed -p 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})') | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'The official portable Node executable did not run.' }
    $npmReady = Test-NodeRuntime $installed -ExpectedVersion '22.23.2' -RequirePublisher
    $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pathFile))
    function Get-RuntimeFilesSnapshot {
      return (@(Get-ChildItem -LiteralPath (Join-Path $env:NODE_FIXTURE_ROOT '.local') -File -Recurse |
        Sort-Object FullName | ForEach-Object { $_.FullName + '|' + $_.Length + '|' + $_.LastWriteTimeUtc.Ticks }) -join "\n")
    }
    $filesBefore = Get-RuntimeFilesSnapshot
    $checked = Invoke-NodeRuntimeSetup -PathFile $pathFile -OnlyCheck
    $recordUnchanged = $before -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($pathFile))
    $filesUnchanged = $filesBefore -eq (Get-RuntimeFilesSnapshot)
    [pscustomobject]@{
      installed=$installed; checked=$checked; publisher=$publisher; version=$runtime.version; arch=$runtime.arch; platform=$runtime.platform
      npmReady=$npmReady; saved=(Read-NodePathRecord $pathFile); recordUnchanged=$recordUnchanged; filesUnchanged=$filesUnchanged
    } | ConvertTo-Json -Compress
  `, {}, 175_000);
  const installed = path.join(installation, ".local/node-runtime", packageName, "node.exe");
  assert.deepEqual(result, {
    installed, checked: installed, publisher: true, version: "22.23.2", arch: "x64", platform: "win32", npmReady: true,
    saved: path.dirname(installed), recordUnchanged: true, filesUnchanged: true,
  });
  assert.ok(existsSync(installed));
  assert.ok(existsSync(path.join(path.dirname(installed), "npm.cmd")));
});
