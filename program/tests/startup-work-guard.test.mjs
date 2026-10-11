import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const [purpose, guarded, allowed] of [["web", false, false], ["database-write", false, false], ["web", true, true], ["database-write", true, false]]) {
  test(`startup guard: ${purpose} held, official web guard=${guarded}`, { skip: process.platform !== "win32" }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lz-startup-"));
    for (const folder of ["scripts", "resources/delivery", "node_modules/wrangler/bin"]) mkdirSync(path.join(dir, folder), { recursive: true });
    for (const file of ["scripts/prepare-login-startup.mjs", "scripts/run-startup-guard.ps1", "scripts/analyzer-instance-lock.ps1", "resources/delivery/recover-startup-work.sql", "resources/delivery/revoke-startup-sessions.sql"]) copyFileSync(path.join(root, file), path.join(dir, file));
    writeFileSync(path.join(dir, ".dev.vars"), "LOCAL_DEV_AUTH=0\nDELIVERY_MODE=0\n");
    writeFileSync(path.join(dir, "node_modules/wrangler/bin/wrangler.js"), 'require("node:fs").writeFileSync("writes.txt", "synthetic database access");');
    const probe = path.join(dir, "probe.ps1");
    writeFileSync(probe, `param([string]$Root,[string]$Node)
      . (Join-Path $Root 'scripts/analyzer-instance-lock.ps1')
      $lock = Enter-AnalyzerInstanceLock $Root '${purpose}'
      if ($null -eq $lock) { throw 'Cannot hold the synthetic gate' }
      try { & $Node (Join-Path $Root 'scripts/prepare-login-startup.mjs') ${guarded ? "--guarded" : ""}; exit $LASTEXITCODE }
      finally { Exit-AnalyzerInstanceLock $lock }`);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe, "-Root", dir, "-Node", process.execPath], { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, allowed ? 0 : 1, result.stderr); assert.equal(existsSync(path.join(dir, "writes.txt")), allowed, "Denied startup reached the database");
  });
}
