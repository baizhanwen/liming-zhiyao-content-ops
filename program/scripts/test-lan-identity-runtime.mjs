import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { cpSync, mkdirSync, openSync, closeSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Actual Vite/Cloudflare LAN binding configuration in an isolated installation.
// Never copy .dev.vars, persistent state, or media; dependencies use the lockfile.
const root = fileURLToPath(new URL("..", import.meta.url));
const installation = path.join(root, ".local/la", randomBytes(4).toString("hex"));
mkdirSync(installation, { recursive: true });
for (const name of ["app", "components", "db", "drizzle", "lib", "worker", "build", "public", "resources", ".openai"]) cpSync(path.join(root, name), path.join(installation, name), { recursive: true });
for (const name of ["package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts", "next.config.ts", "vite.config.ts", "postcss.config.mjs", "wrangler.local.jsonc", "start-local.bat", "setup-local.bat"]) cpSync(path.join(root, name), path.join(installation, name));
cpSync(path.join(root, "scripts"), path.join(installation, "scripts"), { recursive: true });
// Exercise the actual startup while keeping browser/paid analyzer side effects disabled.
writeFileSync(path.join(installation, "scripts/open-local.ps1"), 'param([string]$Url)\n[IO.File]::WriteAllText((Join-Path (Split-Path $PSScriptRoot) ".local/open-request"), $Url)\n');
const port = await new Promise((resolve, reject) => { const socket = createServer(); socket.on("error", reject); socket.listen(0, "127.0.0.1", () => { const value = socket.address().port; socket.close(() => resolve(value)); }); });
const origin = `http://127.0.0.1:${port}`;
const environment = { ...process.env, LAN_MODE: "1", LAN_ACCESS_ORIGIN: `http://192.168.50.10:${port}`, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
writeFileSync(path.join(installation, ".dev.vars"), "LOCAL_DEV_AUTH=1\nDELIVERY_MODE=0\nTRUST_FORWARDED_IDENTITY=1\nLOCAL_DEV_USER_ID=synthetic-local-owner\nLOCAL_DEV_USER_EMAIL=synthetic-owner@example.invalid\nANALYZER_SERVICE_TOKEN=synthetic-unused\n");
mkdirSync(path.join(installation, ".local")); writeFileSync(path.join(installation, ".local/app.port"), String(port));
const log = openSync(path.join(installation, ".local/verification.log"), "a");
let server;
const checks = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") await new Promise(resolve => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("close", resolve); killer.on("error", resolve);
  }); else child.kill("SIGTERM");
  for (let i = 0; i < 50 && child.exitCode === null; i++) await wait(100);
  assert.notEqual(child.exitCode, null, "Child did not stop");
}
async function run(args, { executable = process.execPath, expectedCode = 0, input = "" } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: installation, env: environment, windowsHide: true, stdio: ["pipe", log, log] });
    const timer = setTimeout(() => { void stop(child); reject(new Error("CLI timed out")); }, 300000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code === expectedCode) resolve(); else reject(new Error(`CLI failed (${code}, expected ${expectedCode}); see ${installation}`)); });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
}
async function http(route, { cookie, body, headers = {} } = {}) {
  const response = await fetch(new URL(route, origin), { method: body ? "POST" : "GET", headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const bytes = await response.text(); let data; try { data = JSON.parse(bytes); } catch { data = null; }
  return { status: response.status, headers: response.headers, data };
}
async function start() {
  server = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/run-web-guard.ps1"), "-Entry", "start-local"], { cwd: installation, env: environment, windowsHide: true, stdio: ["pipe", log, log] });
  server.stdin.on("error", () => {}); server.stdin.end("\n");
  let error; server.on("error", value => { error = value; });
  for (let i = 0; i < 90; i++) {
    if (error) throw error;
    if (server.exitCode !== null) throw new Error(`Vite stopped (${server.exitCode})`);
    try { if ((await http("/api/health")).status === 200) return; } catch { /* Wait for readiness. */ }
    await wait(1000);
  }
  throw new Error("Vite did not become ready");
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
const password = randomBytes(18).toString("base64url");
const credentials = { email: "lan-admin@example.invalid", password };
let cookie;
try {
  console.log(`Evidence: ${installation}`);
  await check("official setup installs dependencies, migrates fresh data and preserves supplied configuration", async () => {
    const { readFileSync } = await import("node:fs");
    const original = readFileSync(path.join(installation, ".dev.vars"), "utf8");
    environment.npm_config_cache = path.join(root, ".local/npm-cache");
    environment.npm_config_prefer_offline = "true";
    await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/run-web-guard.ps1"), "-Entry", "setup-local"], { executable: "powershell.exe", input: "\n" });
    assert.equal(readFileSync(path.join(installation, ".dev.vars"), "utf8"), original);
  });
  const cli = path.join(installation, "node_modules/wrangler/bin/wrangler.js");
  await run([cli, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.local.jsonc"]);
  const salt = randomBytes(16), hash = pbkdf2Sync(password, salt, 210000, 32, "sha256");
  const timestamp = new Date().toISOString();
  writeFileSync(path.join(installation, ".local/seed.sql"), `
INSERT INTO users(id,auth_subject,email,display_name,status,created_at,updated_at) VALUES('lan-user','lan-user','${credentials.email}','LAN fixture','active','${timestamp}','${timestamp}');
INSERT INTO local_credentials(user_id,password_salt,password_hash,iterations,created_at,updated_at) VALUES('lan-user','${salt.toString("base64url")}','${hash.toString("base64url")}',210000,'${timestamp}','${timestamp}');
INSERT INTO organizations(id,name,slug,status,created_by,created_at,updated_at) VALUES('lan-org','LAN fixture','lan-fixture','active','lan-user','${timestamp}','${timestamp}');
INSERT INTO organization_members(id,organization_id,user_id,role,status,created_by,updated_by,created_at,updated_at) VALUES('lan-membership','lan-org','lan-user','admin','active','lan-user','lan-user','${timestamp}','${timestamp}');
`);
  await run([cli, "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--file", ".local/seed.sql"]);
  await start();
  await check("actual LAN configuration rejects anonymous and forged proxy headers", async () => {
    for (const headers of [{}, { host: `localhost:${port}` }, { "oai-authenticated-user-id": "synthetic-local-owner", "oai-authenticated-user-email": "synthetic-owner@example.invalid" }]) assert.equal((await http("/api/auth/session", { headers })).status, 401);
    assert.equal((await http("/api/projects?organizationId=lan-org")).status, 401);
    assert.equal((await http("/api/projects", { body: { organizationId: "lan-org", name: "unauthorized fixture" } })).status, 401);
  });
  await check("actual LAN password session can read and write", async () => {
    const response = await http("/api/auth/session", { body: credentials }); assert.equal(response.status, 200, JSON.stringify(response.data)); cookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal((await http("/api/auth/session", { cookie })).status, 200);
    assert.equal((await http("/api/projects", { cookie, body: { organizationId: "lan-org", name: "LAN authorized fixture" } })).status, 201);
  });
  await check("live official startup rejects maintenance and setup without affecting sessions", async () => {
    for (const name of ["backup-local.ps1", "restore-local.ps1", "factory-reset.ps1"]) {
      await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts", name)], { executable: "powershell.exe", expectedCode: 1 });
    }
    await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/run-web-guard.ps1"), "-Entry", "setup-local"], { executable: "powershell.exe", expectedCode: 1 });
    // Intercept only browser opening; the real duplicate-start check and process verification run.
    await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `function Start-Process { param([string]$FilePath) }; & '${path.join(installation, "scripts/run-web-guard.ps1").replaceAll("'", "''")}' -Entry start-local; exit $LASTEXITCODE`], { executable: "powershell.exe" });
    assert.equal((await http("/api/auth/session", { cookie })).status, 200, "A duplicate open revoked a live session");
  });
  await stop(server); server = null;
  await run(["scripts/prepare-login-startup.mjs"]);
  await start();
  await check("actual LAN restart revokes old sessions despite development config", async () => {
    assert.equal((await http("/api/auth/session", { cookie })).status, 401);
    const response = await http("/api/auth/session", { body: credentials }); assert.equal(response.status, 200); cookie = response.headers.get("set-cookie").split(";")[0];
    const projects = await http("/api/projects?organizationId=lan-org", { cookie }); assert.equal(projects.status, 200); assert.ok(projects.data.projects.some(project => project.name === "LAN authorized fixture"));
  });
  await stop(server); server = null;
  await check("after abrupt stop, backup and factory reset use real Wrangler and preserve rollback copies", async () => {
    await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/backup-local.ps1")], { executable: "powershell.exe" });
    writeFileSync(path.join(installation, ".local/douyin-cookies.txt"), "synthetic cookie reset fixture");
    const varsBefore = (await import("node:fs")).readFileSync(path.join(installation, ".dev.vars"), "utf8");
    await run(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installation, "scripts/factory-reset.ps1")], { executable: "powershell.exe", input: "FACTORY RESET\n" });
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    assert.equal(readFileSync(path.join(installation, ".dev.vars"), "utf8"), varsBefore);
    assert.equal(existsSync(path.join(installation, ".local/douyin-cookies.txt")), false);
    const rollback = readdirSync(path.join(installation, "backups")).find(name => name.startsWith("private-reset-"));
    assert.equal(readFileSync(path.join(installation, "backups", rollback, ".local/douyin-cookies.txt"), "utf8"), "synthetic cookie reset fixture");
    assert.ok(readdirSync(path.join(installation, ".wrangler")).some(name => name.startsWith("state-before-factory-reset-")));
    const { DatabaseSync } = await import("node:sqlite");
    const databaseDirectory = path.join(installation, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
    const files = readdirSync(databaseDirectory).filter(name => /^[a-f0-9]{64}\.sqlite$/u.test(name)); assert.equal(files.length, 1);
    const database = new DatabaseSync(path.join(databaseDirectory, files[0]), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM organizations").get().n, 0);
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { database.close(); }
  });
  writeFileSync(path.join(installation, ".local/report.json"), JSON.stringify({ passed: true, checks, boundary: "Actual Vite LAN binding config and Wrangler D1, local HTTP clients; synthetic accounts, no model calls, no real LAN client or OS reboot." }, null, 2));
} catch (error) {
  writeSync(log, error.stack + "\n"); writeFileSync(path.join(installation, ".local/report.json"), JSON.stringify({ passed: false, checks, error: error.message }, null, 2)); console.error(error.stack); process.exitCode = 1;
} finally { await stop(server); closeSync(log); }
