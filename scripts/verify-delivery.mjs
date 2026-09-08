import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Validate the final, pruned customer files in a separate installation. Never
// load the development .dev.vars or touch the customer's persistent storage.
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && existsSync(path.join(packageRoot, "delivery-manifest.json")), "A generated delivery directory is required");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "delivery-manifest.json"), "utf8"));
const runRoot = path.join(sourceRoot, ".local/dv", `${manifest.license.code}-${randomBytes(4).toString("hex")}`);
const installRoot = path.join(runRoot, "Customer install"); // Exercise paths containing spaces.
mkdirSync(runRoot, { recursive: true });
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  assert.ok(!entry.isSymbolicLink(), "Delivery must not contain filesystem links");
  return entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)];
});
const sha = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");
const initialHashes = Object.fromEntries(files(packageRoot).map(file => [path.relative(packageRoot, file).replaceAll("\\", "/"), sha(file)]));
const checks = [];
const log = openSync(path.join(runRoot, "verification.log"), "a");
let server;
function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") return new Promise(resolve => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("close", resolve); killer.on("error", resolve);
  });
  child.kill("SIGTERM");
}
const environment = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", LAN_MODE: "1" };
async function run(executable, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: installRoot, env: environment, windowsHide: true, stdio: ["pipe", log, log] });
    const timer = setTimeout(() => { void stop(child); reject(new Error(`Command timeout: ${path.basename(executable)}`)); }, 900_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${path.basename(executable)} ${args[0]}; see ${runRoot}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}
async function check(name, action) {
  await action(); checks.push(name); console.log(`[PASS] ${name}`);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let origin, cookie, administrator;
const setupCode = randomBytes(24).toString("hex"), password = randomBytes(24).toString("hex");
async function http(route, { method = "GET", body, authenticated = false } = {}) {
  const response = await fetch(new URL(route, origin), { method, headers: { connection: "close", ...(body ? { "content-type": "application/json" } : {}), ...(authenticated ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: "manual" });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}
async function start() {
  const port = await new Promise((resolve, reject) => { const listener = createServer(); listener.on("error", reject); listener.listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  mkdirSync(path.join(installRoot, ".local"), { recursive: true });
  writeFileSync(path.join(installRoot, ".local/app.port"), String(port));
  // Same vinext dev entry and LAN binding as start-lan.ps1; no auto-open helper
  // or media worker is started during this isolated, synthetic acceptance test.
  server = spawn(process.execPath, [path.join(installRoot, "node_modules/vinext/dist/cli.js"), "dev", "--hostname", "0.0.0.0", "--port", String(port)], { cwd: installRoot, env: environment, windowsHide: true, stdio: ["ignore", log, log] });
  let startupError;
  server.on("error", error => { startupError = error; });
  for (let attempt = 0; attempt < 90; attempt++) {
    if (startupError) throw startupError;
    if (server.exitCode !== null) throw new Error(`Delivery server exited: ${server.exitCode}; see ${runRoot}`);
    try { if ((await http("/api/health")).status === 200) return; } catch { /* Wait for compilation. */ }
    await delay(1000);
  }
  throw new Error(`Delivery server did not become ready; see ${runRoot}`);
}

try {
  await check("private-state-and-feature-pruning", async () => {
    for (const file of Object.keys(initialHashes)) assert.ok(!/(^|\/)(\.wrangler|\.local|\.git|node_modules|model-cache|__pycache__|tests)(\/|$)|cookies?\.txt$|\.sqlite$|\.pyc$/i.test(file), `Forbidden delivery file: ${file}`);
    const variables = readFileSync(path.join(packageRoot, ".dev.vars"), "utf8");
    assert.match(variables, /^DELIVERY_MODE=1$/m); assert.match(variables, /^LOCAL_DEV_AUTH=0$/m); assert.match(variables, /^TRUST_FORWARDED_IDENTITY=0$/m);
    assert.ok(!/^[A-Z_]+API_KEY[ \t]*=[ \t]*\S/m.test(variables), "Delivery contains a configured API key");
    const features = manifest.license.features;
    for (const [enabled, folder] of [[features.videoAnalysis, "app/api/videos"], [features.wechatImages, "app/api/wechat-images"], [features.insights, "app/api/reports"]]) assert.equal(existsSync(path.join(packageRoot, folder)), enabled, folder);
  });
  cpSync(packageRoot, installRoot, { recursive: true });
  const syntheticVars = readFileSync(path.join(installRoot, ".dev.vars"), "utf8").replace(/^FIRST_RUN_SETUP_CODE_HASH=.*$/m, `FIRST_RUN_SETUP_CODE_HASH=${createHash("sha256").update(setupCode).digest("hex")}`).replace(/^ANALYZER_SERVICE_TOKEN=.*$/m, `ANALYZER_SERVICE_TOKEN=${randomBytes(32).toString("hex")}`);
  writeFileSync(path.join(installRoot, ".dev.vars"), syntheticVars);
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  assert.ok(existsSync(npmCli), "npm CLI must be installed alongside Node.js");
  await check("clean-npm-ci-and-customer-build", async () => {
    await run(process.execPath, [npmCli, "ci", "--no-audit", "--no-fund"]);
    await run(process.execPath, [npmCli, "run", "build"]);
  });
  await check("fresh-database-migrations-and-lan-entry", async () => {
    await run(process.execPath, ["scripts/run-local-migrations.mjs"]);
    await run(process.execPath, ["scripts/prepare-login-startup.mjs"]);
    await run(process.execPath, ["scripts/sync-authorized-knowledge.mjs"]);
    await start();
    assert.equal((await http("/api/first-run")).data.setupRequired, true);
    assert.equal((await http("/api/auth/session")).status, 401);
  });
  await check("http-first-run-concurrency-and-password-login", async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => http("/api/first-run", { method: "POST", body: { companyName: `Acceptance company ${i}`, administratorName: `Acceptance admin ${i}`, email: `acceptance-${i}@example.invalid`, password, confirmation: password, setupCode } })));
    assert.equal(replies.filter(r => r.status === 201).length, 1);
    assert.equal(replies.filter(r => r.status === 409).length, 7);
    administrator = replies.find(r => r.status === 201).data.installation;
    const login = await http("/api/auth/session", { method: "POST", body: { email: administrator.email, password } });
    assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await http("/api/first-run")).data.setupRequired, false);
    assert.equal((await http("/api/auth/session", { authenticated: true })).status, 200);
    for (const page of ["/", "/settings", "/knowledge", ...(manifest.license.features.videoAnalysis ? ["/analysis"] : [])]) assert.equal((await http(page, { authenticated: true })).status, 200, page);
  });
  let projectId;
  await check("customer-project-write-and-restart-persistence", async () => {
    const created = await http("/api/projects", { method: "POST", authenticated: true, body: { organizationId: administrator.organizationId, name: "Acceptance project" } });
    assert.equal(created.status, 201); projectId = created.data.project.id;
    await stop(server); server = null;
    await run(process.execPath, ["scripts/prepare-login-startup.mjs"]);
    await start();
    assert.equal((await http("/api/auth/session", { authenticated: true })).status, 401);
    const login = await http("/api/auth/session", { method: "POST", body: { email: administrator.email, password } });
    assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    const listed = await http(`/api/projects?organizationId=${administrator.organizationId}`, { authenticated: true });
    assert.ok(listed.data.projects.some(p => p.id === projectId));
  });
  await check("http-concurrent-login-failures-lock-account", async () => {
    const failures = await Promise.all(Array.from({ length: 10 }, () => http("/api/auth/session", { method: "POST", body: { email: administrator.email, password: "incorrect-test-password" } })));
    assert.ok(failures.every(r => [401, 429].includes(r.status)));
    assert.ok(failures.some(r => r.status === 429));
    assert.equal((await http("/api/auth/session", { method: "POST", body: { email: administrator.email, password } })).status, 429);
  });
  await stop(server); server = null;
  await check("customer-backup-and-restore", async () => {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/backup-local.ps1"]);
    const mutationFile = path.join(installRoot, "mutate-acceptance-project.sql");
    writeFileSync(mutationFile, `UPDATE projects SET name = 'Changed after backup' WHERE id = '${projectId}';`);
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--file", mutationFile]);
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/restore-local.ps1"], "1\nRESTORE\n");
    await start();
    // Existing authenticated sessions survive an explicit data restore; daily
    // startup session revocation has its own check above.
    const listed = await http(`/api/projects?organizationId=${administrator.organizationId}`, { authenticated: true });
    assert.equal(listed.status, 200); assert.ok(listed.data.projects.some(p => p.id === projectId && p.name === "Acceptance project"));
  });
  await check("verified-package-files-unchanged", async () => {
    for (const [file, expected] of Object.entries(initialHashes)) assert.equal(sha(path.join(packageRoot, file)), expected, `Package changed during verification: ${file}`);
  });
  const report = { passed: true, buildId: manifest.buildId, testedAt: new Date().toISOString(), checks, runtime: "Customer vinext dev entry with LAN binding; isolated same-host HTTP clients", fieldAcceptance: "pending-real-multi-machine-and-real-video-tests", evidenceDirectory: path.relative(sourceRoot, runRoot).replaceAll("\\", "/") };
  writeFileSync(path.join(packageRoot, "delivery-validation.json"), JSON.stringify(report, null, 2) + "\n");
  manifest.verification = { automated: "passed", report: "delivery-validation.json", fieldAcceptance: "pending" };
  manifest.fileHashes = "delivery-files.sha256.json";
  writeFileSync(path.join(packageRoot, "delivery-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const finalHashes = Object.fromEntries(files(packageRoot).filter(f => path.basename(f) !== "delivery-files.sha256.json").map(file => [path.relative(packageRoot, file).replaceAll("\\", "/"), sha(file)]));
  writeFileSync(path.join(packageRoot, "delivery-files.sha256.json"), JSON.stringify(finalHashes, null, 2) + "\n");
  console.log(`[OK] Candidate verified: ${manifest.buildId}. Real multi-machine/video acceptance remains pending.`);
} catch (error) {
  writeSync(log, `\nVERIFICATION FAILED: ${error.stack}\n`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop(server);
  closeSync(log);
}
