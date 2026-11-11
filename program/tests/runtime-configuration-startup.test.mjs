import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRuntimeConfiguration } from "../scripts/prepare-runtime-configuration.mjs";
import { readLocalRuntimeConfiguration } from "../scripts/analyzer-environment-bridge.mjs";
import { startWebWithEnvironment } from "../scripts/start-web-with-environment.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "liming-isolated-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, ".dev.vars.example"), "LOCAL_DEV_AUTH=1\nANALYZER_SERVICE_TOKEN=local-change-me-before-using-analyzer\nMODEL_SETTINGS_ENCRYPTION_KEY=\nLOCAL_RUNTIME_TOKEN=\nLOCAL_RUNTIME_URL=http://127.0.0.1:3001\nANALYZER_LLM_API_KEY=synthetic-model-key-preserve\n");
  return root;
}

test("first startup generates isolated secrets without returning them, and subsequent or concurrent startup preserves them", async t => {
  const first = fixture(t), second = fixture(t);
  const prepared = await prepareRuntimeConfiguration(first);
  assert.deepEqual(prepared, { created: true, updated: true, configured: true });
  const initial = readLocalRuntimeConfiguration(first);
  for (const name of ["MODEL_SETTINGS_ENCRYPTION_KEY", "LOCAL_RUNTIME_TOKEN", "ANALYZER_SERVICE_TOKEN"]) assert.match(initial[name], /^[a-f\d]{64}$/u);
  assert.equal(initial.ANALYZER_LLM_API_KEY, "synthetic-model-key-preserve");
  if (process.platform !== "win32") assert.equal(statSync(path.join(first, ".dev.vars")).mode & 0o777, 0o600);
  await Promise.all([prepareRuntimeConfiguration(first), prepareRuntimeConfiguration(first)]);
  assert.deepEqual(readLocalRuntimeConfiguration(first), initial);
  await prepareRuntimeConfiguration(second);
  const independent = readLocalRuntimeConfiguration(second);
  assert.notEqual(independent.MODEL_SETTINGS_ENCRYPTION_KEY, initial.MODEL_SETTINGS_ENCRYPTION_KEY);
  assert.notEqual(independent.LOCAL_RUNTIME_TOKEN, initial.LOCAL_RUNTIME_TOKEN);
  assert.doesNotMatch(JSON.stringify(prepared), new RegExp(initial.LOCAL_RUNTIME_TOKEN));
});

test("existing valid defaults and model keys survive bootstrap, while invalid encryption keys are preserved and rejected", async t => {
  const root = fixture(t);
  const template = readFileSync(path.join(root, ".dev.vars.example"), "utf8").replace("MODEL_SETTINGS_ENCRYPTION_KEY=", `MODEL_SETTINGS_ENCRYPTION_KEY=${"a".repeat(64)}`).replace("LOCAL_RUNTIME_TOKEN=", `LOCAL_RUNTIME_TOKEN=${"b".repeat(64)}`).replace("local-change-me-before-using-analyzer", "existing-service-token-preserve");
  writeFileSync(path.join(root, ".dev.vars.example"), template);
  await prepareRuntimeConfiguration(root);
  const configured = readLocalRuntimeConfiguration(root);
  assert.equal(configured.MODEL_SETTINGS_ENCRYPTION_KEY, "a".repeat(64));
  assert.equal(configured.LOCAL_RUNTIME_TOKEN, "b".repeat(64));
  assert.equal(configured.ANALYZER_SERVICE_TOKEN, "existing-service-token-preserve");
  const invalid = template.replace("a".repeat(64), "invalid-key-must-not-be-silently-replaced");
  writeFileSync(path.join(root, ".dev.vars"), invalid);
  await assert.rejects(prepareRuntimeConfiguration(root), /has been preserved/);
  assert.equal(readFileSync(path.join(root, ".dev.vars"), "utf8"), invalid);
  assert.equal(existsSync(path.join(root, ".local/runtime-configuration.lock")), false);
});

test("bootstrap refuses a symlinked configuration instead of modifying another checkout", { skip: process.platform === "win32" }, async t => {
  const root = fixture(t), other = fixture(t);
  const foreign = path.join(other, ".dev.vars"); writeFileSync(foreign, "PRESERVE_ANOTHER_PROJECT=1\n"); chmodSync(foreign, 0o600);
  symlinkSync(foreign, path.join(root, ".dev.vars"));
  await assert.rejects(prepareRuntimeConfiguration(root), /own directory/);
  assert.equal(readFileSync(foreign, "utf8"), "PRESERVE_ANOTHER_PROJECT=1\n");
});

test("production startup forwards all web arguments and closes its own bridge after web exit", async t => {
  const root = fixture(t);
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "node_modules/vinext/dist"), { recursive: true });
  writeFileSync(path.join(root, "scripts/analyzer-environment-bridge.mjs"), "import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{writeFileSync('bridge-stopped.txt','stopped');process.exit(0)});setInterval(()=>{},1000);\n");
  writeFileSync(path.join(root, "node_modules/vinext/dist/cli.js"), "require('node:fs').writeFileSync('web-args.json',JSON.stringify(process.argv.slice(2)));setTimeout(()=>process.exit(7),300);\n");
  const args = ["--port", "31999", "--hostname", "127.0.0.1"];
  const launched = await startWebWithEnvironment({ root, args, listenSignals: false, verifyBridge: async () => {} });
  const bridgeClosed = once(launched.bridge, "close");
  assert.equal(await launched.done, 7);
  await bridgeClosed;
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "web-args.json"), "utf8")), ["start", ...args]);
  assert.equal(readFileSync(path.join(root, ".local/app.port"), "utf8").trim(), "31999");
  assert.equal(launched.bridge.killed, true);
  assert.ok(launched.bridge.exitCode !== null || launched.bridge.signalCode !== null, "The owned bridge must actually exit after the web child closes");
  // Windows terminates a child for SIGTERM without running its JS handler.
  // Both platforms must observe child closure; POSIX also proves graceful handling.
  if (process.platform !== "win32") assert.equal(readFileSync(path.join(root, "bridge-stopped.txt"), "utf8"), "stopped");
});


for (const [name, eol] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`${name} bootstrap preserves comments, blank lines and line endings across restarts`, async t => {
    const root = fixture(t);
    const lines = [
      "# 分析服务通信配置", "\tANALYZER_SERVICE_TOKEN = local-change-me-before-using-analyzer", "",
      "# 已保存模型的加密配置", "  MODEL_SETTINGS_ENCRYPTION_KEY =", "\tLOCAL_RUNTIME_TOKEN =", "",
      "# 模型 API 设置保持原值", "ANALYZER_LLM_API_KEY=synthetic-model-key-preserve",
    ];
    writeFileSync(path.join(root, ".dev.vars.example"), lines.join(eol) + eol);
    await prepareRuntimeConfiguration(root);
    const target = path.join(root, ".dev.vars");
    const first = readFileSync(target, "utf8");
    const configured = readLocalRuntimeConfiguration(root);
    for (const setting of ["MODEL_SETTINGS_ENCRYPTION_KEY", "LOCAL_RUNTIME_TOKEN", "ANALYZER_SERVICE_TOKEN"])
      assert.equal(/^[a-f\d]{64}$/u.test(configured[setting]), true, `Missing generated ${setting}`);
    assert.equal(configured.ANALYZER_LLM_API_KEY, "synthetic-model-key-preserve");
    assert.match(configured.LOCAL_RUNTIME_URL, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const outputLines = first.split(eol);
    assert.equal(outputLines.includes("# 分析服务通信配置"), true);
    assert.equal(outputLines.includes("# 已保存模型的加密配置"), true);
    assert.equal(outputLines.filter(line => line === "").length, 3, "Blank lines and final newline must survive insertion");
    if (eol === "\r\n") {
      assert.equal(/\r(?!\n)|(?<!\r)\n/u.test(first), false, "CRLF must stay complete when settings are replaced or appended");
    } else assert.equal(first.includes("\r"), false);
    const restarted = await prepareRuntimeConfiguration(root);
    assert.equal(restarted.updated, false);
    assert.equal(readFileSync(target, "utf8") === first, true, "Restart must preserve the full generated configuration");
  });
}

test("legacy bare-CR settings preserve existing encryption and service keys during repair", async t => {
  const root = fixture(t), target = path.join(root, ".dev.vars");
  const encryptionKey = "c".repeat(64), runtimeToken = "d".repeat(64), serviceToken = "e".repeat(64);
  const original = `# 旧版 Windows 注释\rMODEL_SETTINGS_ENCRYPTION_KEY=${encryptionKey}\r\n# 通信配置\rLOCAL_RUNTIME_TOKEN=${runtimeToken}\rANALYZER_SERVICE_TOKEN=${serviceToken}\rANALYZER_LLM_API_KEY=synthetic-existing-model-key\r`;
  writeFileSync(target, original);
  await prepareRuntimeConfiguration(root);
  const configured = readLocalRuntimeConfiguration(root);
  assert.equal(configured.MODEL_SETTINGS_ENCRYPTION_KEY, encryptionKey);
  assert.equal(configured.LOCAL_RUNTIME_TOKEN, runtimeToken);
  assert.equal(configured.ANALYZER_SERVICE_TOKEN, serviceToken);
  assert.equal(configured.ANALYZER_LLM_API_KEY, "synthetic-existing-model-key");
  assert.match(configured.LOCAL_RUNTIME_URL, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const repaired = readFileSync(target, "utf8");
  assert.equal(repaired.startsWith(original), true, "Adding a missing URL must preserve existing bare-CR keys");
  assert.equal((await prepareRuntimeConfiguration(root)).updated, false);
  assert.equal(readFileSync(target, "utf8") === repaired, true);
  const invalid = original.replace(encryptionKey, "invalid-existing-key-preserve");
  writeFileSync(target, invalid);
  await assert.rejects(prepareRuntimeConfiguration(root), /has been preserved/);
  assert.equal(readFileSync(target, "utf8") === invalid, true, "An invalid existing key must never be silently replaced");
});
