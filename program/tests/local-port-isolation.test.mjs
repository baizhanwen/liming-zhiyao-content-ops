import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("port selection distinguishes two installations and preserves an owned healthy listener", { skip: process.platform !== "win32" }, async t => {
  const parent = path.join(root, ".local/port-tests"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(path.join(parent, "path with spaces and apostrophe's-"));
  const installations = [path.join(dir, "app"), path.join(dir, "app-extra")];
  for (const install of installations) {
    mkdirSync(path.join(install, "scripts"), { recursive: true }); mkdirSync(path.join(install, ".local"));
    for (const name of ["select-local-port.ps1", "local-web-identity.ps1", "local-runtime-identity.mjs", "start-lan.ps1", "analyzer-instance-lock.ps1"]) {
      const source = path.join(root, "scripts", name);
      if (existsSync(source)) copyFileSync(source, path.join(install, "scripts", name));
    }
  }
  const [current, foreign] = installations;
  const server = path.join(foreign, "node_modules/vinext/bin/server.mjs"); mkdirSync(path.dirname(server), { recursive: true });
  writeFileSync(server, `import http from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeSourceId } from '../../../scripts/local-runtime-identity.mjs';
const sourceId = runtimeSourceId(fileURLToPath(new URL('../../../', import.meta.url)));
const server = http.createServer((req, res) => { res.writeHead(existsSync(new URL('../../../.local/unhealthy', import.meta.url)) ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ok:true,localRuntimeSourceId:sourceId})); });
server.listen(0, '127.0.0.1', () => writeFileSync(new URL('../../../.local/port', import.meta.url), String(server.address().port)));
`);
  const child = spawn(process.execPath, [server, "dev"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", data => { errors += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await wait(30);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "Synthetic listener did not stop");
  });
  const portFile = path.join(foreign, ".local/port");
  for (let i = 0; i < 100 && !existsSync(portFile) && child.exitCode === null; i++) await wait(30);
  assert.ok(existsSync(portFile), errors);
  const occupied = Number(readFileSync(portFile, "utf8"));
  for (const install of installations) writeFileSync(path.join(install, ".local/app.port"), String(occupied));
  const select = (install, args = []) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(install, "scripts/select-local-port.ps1"), ...args], { windowsHide: true, encoding: "utf8", timeout: 20000 });
  const local = select(current); assert.equal(local.status, 0, local.stderr);
  assert.notEqual(Number(local.stdout.trim()), occupied, "Foreign healthy service was opened as the current installation");
  assert.equal(Number(readFileSync(path.join(current, ".local/app.port"), "utf8")), Number(local.stdout.trim()));
  writeFileSync(path.join(current, ".local/app.port"), String(occupied));
  const lan = select(current, ["-BindAll"]); assert.equal(lan.status, 0, lan.stderr); assert.notEqual(Number(lan.stdout.trim()), occupied);
  const owned = select(foreign); assert.equal(owned.status, 0, owned.stderr); assert.equal(Number(owned.stdout.trim()), occupied);
  for (const [install, expectedCode] of [[current, 1], [foreign, 0]]) {
    const health = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(install, "scripts/local-web-identity.ps1"), "-CheckHealth", "-HealthPort", String(occupied)], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(health.status, expectedCode, health.stderr);
  }
  writeFileSync(path.join(foreign, ".local/unhealthy"), "synthetic failure");
  const unhealthy = select(foreign); assert.notEqual(unhealthy.status, 0); assert.match(unhealthy.stderr, /already listening.+unhealthy/);
  assert.equal(Number(readFileSync(path.join(foreign, ".local/app.port"), "utf8")), occupied, "Unhealthy app changed its recorded port");
  unlinkSync(path.join(foreign, ".local/unhealthy"));
  writeFileSync(path.join(current, ".local/app.port"), "99999");
  const invalid = select(current); assert.equal(invalid.status, 0, invalid.stderr);
  assert.ok(Number(invalid.stdout.trim()) >= 1 && Number(invalid.stdout.trim()) <= 65535);
  // Run the actual LAN entry with controlled setup/network/browser/npm boundaries.
  // The foreign server is real; no production configuration or analyzer is used.
  writeFileSync(path.join(current, ".local/app.port"), String(occupied));
  // The real preparation script exits explicitly. Preserve that boundary so
  // Windows PowerShell updates the calling script's LASTEXITCODE as in use.
  writeFileSync(path.join(current, "scripts/prepare-local-web.ps1"), "param([switch]$CheckDependenciesOnly)\nexit 0\n");
  writeFileSync(path.join(current, "scripts/open-lan.ps1"), "param([string]$Url, [string]$HealthUrl)\n");
  const probe = path.join(current, "scripts/probe.ps1");
  writeFileSync(probe, `
# Port inspection auto-loads NetTCPIP, whose exports include Get-NetIPConfiguration.
# Load it before defining the mock so auto-loading cannot replace this boundary.
Import-Module NetTCPIP -ErrorAction Stop
function Get-NetIPConfiguration { [IO.File]::WriteAllText((Join-Path (Split-Path $PSScriptRoot) '.local/lan-network-probe'), 'fixture'); return [pscustomobject]@{ IPv4Address=@([pscustomobject]@{IPAddress='192.168.50.10'}); IPv4DefaultGateway='synthetic'; NetAdapter=[pscustomobject]@{Status='Up'}; InterfaceDescription='Synthetic fixture'; InterfaceAlias='Ethernet' } }
function npm.cmd { [IO.File]::WriteAllText((Join-Path (Split-Path $PSScriptRoot) '.local/lan-start'), $env:LAN_ACCESS_ORIGIN); $global:LASTEXITCODE=0 }
& (Join-Path $PSScriptRoot 'start-lan.ps1')
exit $LASTEXITCODE
`);
  const entry = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe], { windowsHide: true, encoding: "utf8", timeout: 25000 });
  const entryOutput = [entry.error?.message, entry.stderr, entry.stdout].filter(Boolean).join("\n");
  assert.equal(entry.status, 0, entryOutput);
  assert.ok(existsSync(path.join(current, ".local/lan-network-probe")), `LAN entry did not use its controlled network fixture:\n${entryOutput}`);
  assert.ok(existsSync(path.join(current, ".local/lan-start")), `LAN entry did not reach its controlled npm boundary:\n${entryOutput}`);
  assert.notEqual(Number(new URL(readFileSync(path.join(current, ".local/lan-start"), "utf8")).port), occupied);
  const identityScript = path.join(foreign, "scripts/local-web-identity.ps1");
  writeFileSync(identityScript, readFileSync(identityScript, "utf8") + "\n# synthetic upgrade after the listener started\n");
  const stale = select(foreign);
  assert.notEqual(stale.status, 0, "A still-running old web process was silently reused after an upgrade");
  assert.match(stale.stderr, /still running an older version/);
  assert.equal(Number(readFileSync(path.join(foreign, ".local/app.port"), "utf8")), occupied);
  writeFileSync(path.join(dir, "report.json"), JSON.stringify({ synthetic: true, foreignHealthyPortSkipped: true, lanForeignPortSkipped: true, ownHealthyPortReused: true, unhealthyOwnedInstanceBlocked: true, invalidPortIgnored: true, actualLanEntryForeignInstanceSkipped: true, staleWebVersionBlocked: true }, null, 2));
});
