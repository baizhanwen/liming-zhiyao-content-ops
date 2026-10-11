import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Execute the exact documented commands against synthetic files, never .dev.vars
// from the working installation. Configuration contents never enter the report.
const root = fileURLToPath(new URL("..", import.meta.url)), directory = mkdtempSync(path.join(tmpdir(), "lz-cfg-"));
const source = path.join(directory, "source [synthetic]"), target = path.join(directory, "restore [synthetic]");
for (const folder of [source, target]) mkdirSync(path.join(folder, ".local"), { recursive: true });
const names = [".dev.vars", ".dev.vars.local", ".env", ".env.production", ".env.local", ".env.test[synthetic]"];
const sourceBytes = Object.fromEntries(names.map(name => [name, Buffer.from(`SYNTHETIC_ONLY=${name}\r\n`)]));
for (const name of names) { writeFileSync(path.join(source, name), sourceBytes[name]); writeFileSync(path.join(target, name), `SYNTHETIC_PREVIOUS=${name}`); }
for (const name of [".dev.vars.example", ".env.example", "unrelated.txt"]) writeFileSync(path.join(source, name), "synthetic excluded");
writeFileSync(path.join(source, ".local/douyin-cookies.txt"), "# Netscape HTTP Cookie File\n# synthetic saved cookie\n");
writeFileSync(path.join(target, ".local/douyin-cookies.txt"), "synthetic previous cookie");
const external = path.join(directory, "external [synthetic].txt"); writeFileSync(external, "synthetic external cookie");
const guide = readFileSync(path.join(root, "docs/operations/备份恢复与升级操作.md"), "utf8");
const blocks = Array.from(guide.matchAll(/```powershell\r?\n([\s\S]*?)```/g), match => match[1]);
const backup = blocks.find(block => block.includes("Private configuration saved")), restore = blocks.find(block => block.includes("Previous configuration retained"));
const externalBackup = blocks.find(block => block.includes("$configuredCookieFile ="));
assert.ok(backup && restore && externalBackup, "documented copy commands must be present");
function execute(cwd, code, env = {}, expectSuccess = true) {
  const script = path.join(directory, `command-${execute.count++}.ps1`); writeFileSync(script, "\ufeffSet-Location -LiteralPath $env:CONFIG_TEST_CWD\n" + code);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { cwd, env: { ...process.env, ...env, CONFIG_TEST_CWD: cwd }, encoding: "utf8", windowsHide: true, timeout: 30000 });
  if (expectSuccess) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, "expected a copy failure");
  return result;
}
execute.count = 0;
const startedAt = new Date().toISOString();
execute(source, backup);
const privateCopy = path.join(source, "backups", readdirSync(path.join(source, "backups"))[0]);
assert.deepEqual(readdirSync(privateCopy).filter(name => name !== ".local").sort(), [...names].sort());
for (const name of names) assert.deepEqual(readFileSync(path.join(privateCopy, name)), sourceBytes[name]);
assert.equal(readFileSync(path.join(privateCopy, ".local/douyin-cookies.txt"), "utf8"), readFileSync(path.join(source, ".local/douyin-cookies.txt"), "utf8"));
execute(source, `$configCopy = $env:CONFIG_TEST_COPY\n` + externalBackup.replace("'C:\\private\\douyin-cookies.txt'", "$env:CONFIG_TEST_EXTERNAL"), { CONFIG_TEST_COPY: privateCopy, CONFIG_TEST_EXTERNAL: external });
assert.deepEqual(readFileSync(path.join(privateCopy, "configured-cookie.txt")), readFileSync(external));
execute(target, restore.replace("'C:\\private\\private-config-已验证副本'", "$env:CONFIG_TEST_COPY"), { CONFIG_TEST_COPY: privateCopy });
for (const name of names) assert.deepEqual(readFileSync(path.join(target, name)), sourceBytes[name]);
const previous = path.join(target, "backups", readdirSync(path.join(target, "backups"))[0]);
for (const name of names) assert.equal(readFileSync(path.join(previous, name), "utf8"), `SYNTHETIC_PREVIOUS=${name}`);
assert.equal(readFileSync(path.join(previous, ".local/douyin-cookies.txt"), "utf8"), "synthetic previous cookie");
assert.equal(readFileSync(path.join(target, ".local/douyin-cookies.txt"), "utf8"), readFileSync(path.join(source, ".local/douyin-cookies.txt"), "utf8"));
const failedTarget = path.join(directory, "failed restore [synthetic]"); mkdirSync(path.join(failedTarget, ".local"), { recursive: true });
for (const name of names) writeFileSync(path.join(failedTarget, name), `SYNTHETIC_BEFORE_FAILURE=${name}`);
writeFileSync(path.join(failedTarget, ".local/douyin-cookies.txt"), "synthetic retained cookie");
const failCopy = `
$script:configWrites = 0
function Copy-Item {
    param([string]$LiteralPath, [string]$Destination)
    if ($Destination.StartsWith($env:CONFIG_TEST_CWD + '\\', [StringComparison]::OrdinalIgnoreCase) -and -not $Destination.Contains('backups')) {
        $script:configWrites += 1
        if ($script:configWrites -eq 2) { throw 'Synthetic configuration copy failure' }
    }
    Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination
}
`;
const failed = execute(failedTarget, failCopy + restore.replace("'C:\\private\\private-config-已验证副本'", "$env:CONFIG_TEST_COPY"), { CONFIG_TEST_COPY: privateCopy }, false);
assert.match(failed.stderr, /Synthetic configuration copy failure/);
assert.equal(names.filter(name => readFileSync(path.join(failedTarget, name), "utf8").startsWith("SYNTHETIC_ONLY=")).length, 1);
const failureRollback = path.join(failedTarget, "backups", readdirSync(path.join(failedTarget, "backups"))[0]);
execute(failedTarget, restore.replace("'C:\\private\\private-config-已验证副本'", "$env:CONFIG_TEST_COPY"), { CONFIG_TEST_COPY: failureRollback });
for (const name of names) assert.equal(readFileSync(path.join(failedTarget, name), "utf8"), `SYNTHETIC_BEFORE_FAILURE=${name}`);
assert.equal(readFileSync(path.join(failedTarget, ".local/douyin-cookies.txt"), "utf8"), "synthetic retained cookie");
const report = { passed: true, synthetic: true, startedAt, finishedAt: new Date().toISOString(), configurationFiles: names.length, defaultCookieRecovered: true, externalCookieCopiedSeparately: true, previousConfigurationPreserved: true, partialCopyFailureStopped: true, manualRollbackRecoveredAllOriginals: true, examplesAndUnrelatedFilesExcluded: true, literalBracketPaths: true, guideSha256: createHash("sha256").update(guide).digest("hex"), boundary: "Exact documentation commands with synthetic files only; no real keys, OS environment migration, model calls or automatic atomic config restore.", directory };
writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, evidence: path.join(directory, "report.json") }));
