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
for (const name of ["package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts", "next.config.ts", "vite.config.ts", "postcss.config.mjs", "wrangler.local.jsonc"]) cpSync(path.join(root, name), path.join(installation, name));
mkdirSync(path.join(installation, "scripts"));
cpSync(path.join(root, "scripts/prepare-login-startup.mjs"), path.join(installation, "scripts/prepare-login-startup.mjs"));
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
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: installation, env: environment, windowsHide: true, stdio: ["ignore", log, log] });
    const timer = setTimeout(() => { void stop(child); reject(new Error("CLI timed out")); }, 300000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`CLI failed (${code}); see ${installation}`)); });
  });
}
async function http(route, { cookie, body, headers = {} } = {}) {
  const response = await fetch(new URL(route, origin), { method: body ? "POST" : "GET", headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const bytes = await response.text(); let data; try { data = JSON.parse(bytes); } catch { data = null; }
  return { status: response.status, headers: response.headers, data };
}
async function start() {
  server = spawn(process.execPath, [path.join(installation, "node_modules/vinext/dist/cli.js"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: installation, env: environment, windowsHide: true, stdio: ["ignore", log, log] });
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
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await run([npmCli, "ci", "--prefer-offline", "--no-audit", "--no-fund", "--cache", path.join(root, ".local/npm-cache")]);
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
  await stop(server); server = null;
  await run(["scripts/prepare-login-startup.mjs"]);
  await start();
  await check("actual LAN restart revokes old sessions despite development config", async () => {
    assert.equal((await http("/api/auth/session", { cookie })).status, 401);
    const response = await http("/api/auth/session", { body: credentials }); assert.equal(response.status, 200); cookie = response.headers.get("set-cookie").split(";")[0];
    const projects = await http("/api/projects?organizationId=lan-org", { cookie }); assert.equal(projects.status, 200); assert.ok(projects.data.projects.some(project => project.name === "LAN authorized fixture"));
  });
  writeFileSync(path.join(installation, ".local/report.json"), JSON.stringify({ passed: true, checks, boundary: "Actual Vite LAN binding config and Wrangler D1, local HTTP clients; synthetic accounts, no model calls, no real LAN client or OS reboot." }, null, 2));
} catch (error) {
  writeSync(log, error.stack + "\n"); writeFileSync(path.join(installation, ".local/report.json"), JSON.stringify({ passed: false, checks, error: error.message }, null, 2)); console.error(error.stack); process.exitCode = 1;
} finally { await stop(server); closeSync(log); }
