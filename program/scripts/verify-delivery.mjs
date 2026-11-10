import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, closeSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { verifyDeliveryDocumentation } from "./delivery-documentation.mjs";
import { verifyDeliveryScripts } from "./delivery-script-policy.mjs";

// Validate the final, pruned customer files in a separate installation. Never
// load the development .dev.vars or touch the customer's persistent storage.
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && existsSync(path.join(packageRoot, "delivery-manifest.json")), "A generated delivery directory is required");
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "delivery-manifest.json"), "utf8"));
const githubDistribution = manifest.distribution === "github";
const runRoot = path.join(sourceRoot, ".local/dv", `${manifest.license.code}-${randomBytes(4).toString("hex")}`);
const installRoot = path.join(runRoot, "客户 install"); // Exercise Chinese and spaces.
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
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ANALYZER_|CONTENT_MODEL_|PROJECT_ASSISTANT_MODEL_|LOCAL_RUNTIME_|MODEL_SETTINGS_|FIRST_RUN_|LOCAL_DEV_|DELIVERY_MODE$|GH_TOKEN$|GITHUB_TOKEN$)/u.test(name))),
  CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", LAN_MODE: "1",
};
async function run(executable, args, input, expectedFailure = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: installRoot, env: environment, windowsHide: true, stdio: ["pipe", log, log] });
    const timer = setTimeout(() => { void stop(child); reject(new Error(`Command timeout: ${path.basename(executable)}`)); }, 900_000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if ((!expectedFailure && code === 0) || (expectedFailure && Number.isInteger(code) && code > 0)) resolve(code);
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
    verifyDeliveryScripts(Object.keys(initialHashes), features);
    for (const filename of ["build/analyzer-environment-plugin.ts", "scripts/start-web-with-environment.mjs", "scripts/prepare-runtime-configuration.mjs", "scripts/analyzer-environment-bridge.mjs"])
      assert.ok(existsSync(path.join(packageRoot, filename)), `Missing settings runtime: ${filename}`);
    if (features.videoAnalysis) for (const filename of ["scripts/analyzer_local_runtime.py", "scripts/prepare_analyzer_models.py", "services/analyzer/uv.lock", "services/analyzer/liming_analyzer/douyin_collector/node/package-lock.json"])
      assert.ok(existsSync(path.join(packageRoot, filename)), `Missing video environment dependency: ${filename}`);
    if (githubDistribution) {
      assert.equal(manifest.activationRequired, false);
      assert.equal(manifest.authorizedKnowledge.included, true);
      assert.equal(manifest.license.name, "开发完整版");
      assert.equal(features.videoAnalysis, true); assert.equal(features.insights, true);
      assert.match(variables, /^FIRST_RUN_REQUIRE_SETUP_CODE=0$/m);
      for (const name of ["FIRST_RUN_SETUP_CODE", "FIRST_RUN_SETUP_CODE_HASH", "LOCAL_RUNTIME_TOKEN", "MODEL_SETTINGS_ENCRYPTION_KEY", "ANALYZER_SERVICE_TOKEN"])
        assert.match(variables, new RegExp(`^${name}=[ \\t]*$`, "m"), `Shared secret in GitHub download: ${name}`);
      assert.ok(!Object.keys(initialHashes).some(filename => /delivery-credential/i.test(filename)), "GitHub downloads must not contain activation credentials");
    }
    if (!features.videoAnalysis) assert.doesNotMatch(readFileSync(path.join(packageRoot, "scripts/open-web.ps1"), "utf8"), /start-analyzer-background\.ps1/, "Starter opener refers to a removed video service");
    assert.equal(existsSync(path.join(packageRoot, "lib/csv-table.ts")), Boolean(features.insights), "CSV reader must follow the insights entitlement");
    for (const [enabled, folder] of [[features.videoAnalysis, "app/api/videos"], [features.wechatImages, "app/api/wechat-images"], [features.insights, "app/api/reports"]]) assert.equal(existsSync(path.join(packageRoot, folder)), enabled, folder);
    for (const file of ["scripts/test-ecommerce-browser.mjs", "scripts/test-ecommerce-model.mjs", "scripts/ecommerce-test-model.mjs"]) assert.equal(existsSync(path.join(packageRoot, file)), false, `Test helper in delivery: ${file}`);
    if (!manifest.authorizedKnowledge.included) {
      const catalog = readFileSync(path.join(packageRoot, "lib/ecommerce/starter-catalog.ts"), "utf8");
      assert.match(catalog, /ECOMMERCE_STARTER_VERSION = "excluded"/);
      assert.doesNotMatch(catalog, /scene-question|barrier-first|authorized-methodology-router/);
    }
  });
  await check("offline-customer-manual-and-recovery-links", async () => {
    verifyDeliveryDocumentation(packageRoot, sourceRoot);
  });
  cpSync(packageRoot, installRoot, { recursive: true });
  await check("per-installation-runtime-secrets", async () => {
    await run(process.execPath, ["scripts/prepare-runtime-configuration.mjs"]);
    const variables = readFileSync(path.join(installRoot, ".dev.vars"), "utf8");
    for (const name of ["MODEL_SETTINGS_ENCRYPTION_KEY", "LOCAL_RUNTIME_TOKEN", "ANALYZER_SERVICE_TOKEN"])
      assert.match(variables, new RegExp(`^${name}=[a-f0-9]{64}$`, "m"));
    await run(process.execPath, ["scripts/prepare-runtime-configuration.mjs"]);
    assert.equal(readFileSync(path.join(installRoot, ".dev.vars"), "utf8"), variables, "Restart must preserve this installation's generated secrets");
  });
  let syntheticVars = readFileSync(path.join(installRoot, ".dev.vars"), "utf8");
  if (!githubDistribution) syntheticVars = syntheticVars.replace(/^FIRST_RUN_SETUP_CODE_HASH=.*$/m, `FIRST_RUN_SETUP_CODE_HASH=${createHash("sha256").update(setupCode).digest("hex")}`);
  // Exercise an older configuration with none of the newly added timeout keys.
  syntheticVars = syntheticVars.replace(/^ANALYZER_TIMEOUT_[A-Z_]+=.*\r?\n/gm, "") + "\nLEGACY_CUSTOM_SETTING=preserve-this\n";
  if (manifest.license.features.videoAnalysis && process.env.DELIVERY_TEST_PYTHON_ENV) {
    const mediaRoot = path.join(installRoot, ".local/test-media"); mkdirSync(mediaRoot, { recursive: true });
    for (const executable of ["ffmpeg.exe", "ffprobe.exe"]) cpSync(path.join(process.env.SystemRoot || "C:/Windows", "System32/cmd.exe"), path.join(mediaRoot, executable));
    const fixtureSettings = { ANALYZER_LLM_API_KEY: "synthetic-unused", ANALYZER_LLM_BASE_URL: "https://example.invalid/v1", ANALYZER_LLM_MODEL: "synthetic-unused", ANALYZER_LLM_PROVIDER: "openai", ANALYZER_WORKER_ID: "delivery-empty-queue", ANALYZER_YTDLP_COOKIES_FROM_BROWSER: "none", ANALYZER_FFMPEG: path.join(mediaRoot, "ffmpeg.exe"), ANALYZER_FFPROBE: path.join(mediaRoot, "ffprobe.exe") };
    for (const [key, value] of Object.entries(fixtureSettings)) {
      const expression = new RegExp(`^${key}=.*$`, "m");
      syntheticVars = expression.test(syntheticVars) ? syntheticVars.replace(expression, () => `${key}=${value}`) : `${syntheticVars}\n${key}=${value}\n`;
    }
  }
  writeFileSync(path.join(installRoot, ".dev.vars"), syntheticVars);
  await check("legacy-database-upgrade-preserves-existing-rows", async () => {
    const legacy = new DatabaseSync(path.join(runRoot, "legacy-upgrade.sqlite"));
    try {
      const migrations = readdirSync(path.join(installRoot, "drizzle")).filter(name => name.endsWith(".sql")).sort();
      for (const name of migrations.filter(name => name < "0049")) legacy.exec(readFileSync(path.join(installRoot, "drizzle", name), "utf8"));
      const stamp = "2026-09-01T00:00:00.000Z";
      legacy.prepare("INSERT INTO users (id, auth_subject, email, status, created_at, updated_at) VALUES ('legacy-user','legacy-user','legacy@example.invalid','active',?,?)").run(stamp, stamp);
      legacy.prepare("INSERT INTO organizations (id,name,slug,created_by,created_at,updated_at) VALUES ('legacy-org','Legacy','legacy','legacy-user',?,?)").run(stamp, stamp);
      legacy.prepare("INSERT INTO projects (id,organization_id,name,client_name,status,created_by,updated_by,created_at,updated_at) VALUES ('legacy-project','legacy-org','Legacy project','Legacy','active','legacy-user','legacy-user',?,?)").run(stamp, stamp);
      legacy.prepare("INSERT INTO videos (id,organization_id,project_id,platform,source_type,source_url,source_hash,status,created_by,updated_by,created_at,updated_at) VALUES ('legacy-video','legacy-org','legacy-project','douyin','url','https://example.invalid/video','legacy-hash','pending','legacy-user','legacy-user',?,?)").run(stamp, stamp);
      legacy.prepare("INSERT INTO analysis_jobs (id,organization_id,project_id,video_id,source_type,source_ref,idempotency_key,status,checkpoint_stage,checkpoint_json,attempt_count,created_by,updated_by,created_at,updated_at) VALUES ('legacy-job','legacy-org','legacy-project','legacy-video','url','https://example.invalid/video','legacy-hash','pending','evidence_ready','{\"checkpoint_version\":1}',2,'legacy-user','legacy-user',?,?)").run(stamp, stamp);
      const before = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => {
        const columns = legacy.prepare(`PRAGMA table_info("${name}")`).all().map(column => `"${column.name}"`).join(",");
        const query = `SELECT ${columns} FROM "${name}"`;
        return { query, rows: JSON.stringify(legacy.prepare(query).all()) };
      });
      for (const name of migrations.filter(name => name >= "0049")) legacy.exec(readFileSync(path.join(installRoot, "drizzle", name), "utf8"));
      for (const table of before) assert.equal(JSON.stringify(legacy.prepare(table.query).all()), table.rows, table.query);
      assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM analysis_model_calls").get().n, 0);
    } finally { legacy.close(); }
    assert.equal(readFileSync(path.join(installRoot, ".dev.vars"), "utf8"), syntheticVars);
  });
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
    const firstRun = (await http("/api/first-run")).data;
    assert.equal(firstRun.setupRequired, true);
    assert.equal(firstRun.setupCodeRequired, !githubDistribution);
    assert.equal((await http("/api/auth/session")).status, 401);
  });
  await check("http-first-run-concurrency-and-password-login", async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => http("/api/first-run", { method: "POST", body: { companyName: `Acceptance company ${i}`, administratorName: `Acceptance admin ${i}`, email: `acceptance-${i}@example.invalid`, password, confirmation: password, ...(!githubDistribution ? { setupCode } : {}) } })));
    assert.equal(replies.filter(r => r.status === 201).length, 1);
    assert.equal(replies.filter(r => r.status === 409).length, 7);
    administrator = replies.find(r => r.status === 201).data.installation;
    const login = await http("/api/auth/session", { method: "POST", body: { email: administrator.email, password } });
    assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await http("/api/first-run")).data.setupRequired, false);
    assert.equal((await http("/api/auth/session", { authenticated: true })).status, 200);
    for (const page of ["/", "/settings", "/knowledge", ...(manifest.license.features.videoAnalysis ? ["/analysis"] : [])]) assert.equal((await http(page, { authenticated: true })).status, 200, page);
  });
  if (manifest.license.features.videoAnalysis && process.env.DELIVERY_TEST_PYTHON_ENV) await check("analyzer-empty-queue-concurrent-start-and-supervisor-recovery", async () => {
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(sourceRoot, "scripts/verify-analyzer-delivery.ps1"), "-InstallRoot", installRoot, "-PythonEnvironment", process.env.DELIVERY_TEST_PYTHON_ENV, "-BaseUrl", origin]);
    assert.equal(readFileSync(path.join(installRoot, ".dev.vars"), "utf8"), syntheticVars, "Existing configuration was modified by analyzer startup");
  });
  let projectId;
  await check("customer-project-write-and-restart-persistence", async () => {
    const created = await http("/api/projects", { method: "POST", authenticated: true, body: { organizationId: administrator.organizationId, name: "Acceptance project" } });
    assert.equal(created.status, 201); projectId = created.data.project.id;
    if (manifest.authorizedKnowledge.included) {
      const library = await http(`/api/authorized-knowledge?organizationId=${administrator.organizationId}&projectId=${projectId}`, { authenticated: true });
      assert.equal(library.status, 200);
      assert.equal(library.data.source.item_count, manifest.authorizedKnowledge.atomCount);
      assert.ok(library.data.atoms.length > 0, "Bundled methods must be searchable after first setup");
    }
    if (manifest.license.features.videoAnalysis) {
      const runtime = await http(`/api/analyzer-environment?organizationId=${administrator.organizationId}`, { authenticated: true });
      assert.equal(runtime.status, 200);
      if (process.env.DELIVERY_VERIFY_ENVIRONMENT_BRIDGE === "1") assert.equal(runtime.data.available, true, "Settings must connect to this package's environment manager");
    }
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
  await stop(server); server = null;
  await check("partial-migration-failure-and-matched-state-rollback", async () => {
    const started = Date.now();
    // Unlock only the synthetic account from the preceding lockout test. The
    // rollback must allow a fresh password login, rather than reuse a session.
    const unlockFile = path.join(runRoot, "unlock-synthetic-account.sql");
    writeFileSync(unlockFile, "DELETE FROM local_login_attempts;");
    await run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--file", unlockFile]);
    const d1Root = path.join(installRoot, ".wrangler/state/v3/d1");
    // Miniflare also creates metadata.sqlite for alarms. Select the actual
    // application database by its schema and the project created over HTTP.
    const databaseFile = files(d1Root).filter(f => f.endsWith(".sqlite")).filter(filename => {
      const db = new DatabaseSync(filename, { readOnly: true });
      try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get() && db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)); }
      finally { db.close(); }
    });
    assert.equal(databaseFile.length, 1, "Expected one HTTP project database");
    const database = action => {
      const db = new DatabaseSync(databaseFile[0], { readOnly: true });
      try { return action(db); } finally { db.close(); }
    };
    const snapshot = () => database(db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()])));
    const before = snapshot();
    const configurationHash = sha(path.join(installRoot, ".dev.vars"));
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/backup-local.ps1"]);
    const backups = readdirSync(path.join(installRoot, "backups")).filter(f => f.endsWith(".zip")).sort();
    const backup = path.join(installRoot, "backups", backups.at(-1));
    const retainedProgram = path.join(runRoot, "program-before-upgrade");
    cpSync(packageRoot, retainedProgram, { recursive: true });
    cpSync(path.join(installRoot, ".dev.vars"), path.join(runRoot, "private-config-before-upgrade"));
    const first = "9998_acceptance_partial_upgrade.sql", second = "9999_acceptance_failed_upgrade.sql";
    for (const name of [first, second]) assert.equal(existsSync(path.join(installRoot, "drizzle", name)), false);
    writeFileSync(path.join(installRoot, "drizzle", first), "CREATE TABLE acceptance_upgrade_marker (id INTEGER PRIMARY KEY); INSERT INTO acceptance_upgrade_marker VALUES (1); UPDATE projects SET name = 'Partially upgraded';\n");
    writeFileSync(path.join(installRoot, "drizzle", second), "INSERT INTO acceptance_missing_table VALUES (1);\n");
    const failureCode = await run(process.execPath, ["scripts/run-local-migrations.mjs"], undefined, true);
    database(db => {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM acceptance_upgrade_marker").get().count, 1);
      assert.equal(db.prepare("SELECT name FROM projects WHERE id=?").get(projectId).name, "Partially upgraded");
      const applied = db.prepare("SELECT name FROM d1_migrations").all().map(r => r.name);
      assert.ok(applied.includes(first)); assert.ok(!applied.includes(second));
    });
    // Keep failed migration files and the pre-restore database for inspection.
    // This is a synthetic upgrade of this candidate, not two released versions.
    renameSync(path.join(installRoot, "drizzle"), path.join(runRoot, "failed-upgrade-migrations"));
    cpSync(retainedProgram, installRoot, { recursive: true });
    cpSync(path.join(runRoot, "private-config-before-upgrade"), path.join(installRoot, ".dev.vars"));
    for (const [file, expected] of Object.entries(initialHashes)) if (file !== ".dev.vars") assert.equal(sha(path.join(installRoot, file)), expected, `Rollback program mismatch: ${file}`);
    assert.equal(sha(path.join(installRoot, ".dev.vars")), configurationHash);
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/restore-local.ps1", "-BackupPath", backup], "RESTORE\n");
    assert.deepEqual(snapshot(), before, "Rollback must restore all D1 rows and migration metadata");
    await run(process.execPath, ["scripts/run-local-migrations.mjs"]);
    await run(process.execPath, ["scripts/prepare-login-startup.mjs"]);
    await start();
    assert.equal((await http("/api/auth/session", { authenticated: true })).status, 401);
    const login = await http("/api/auth/session", { method: "POST", body: { email: administrator.email, password } });
    assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
    const listed = await http(`/api/projects?organizationId=${administrator.organizationId}`, { authenticated: true });
    assert.equal(listed.status, 200); assert.ok(listed.data.projects.some(p => p.id === projectId && p.name === "Acceptance project"));
    const created = await http("/api/projects", { method: "POST", authenticated: true, body: { organizationId: administrator.organizationId, name: "After upgrade rollback" } });
    assert.equal(created.status, 201);
    writeFileSync(path.join(runRoot, "upgrade-rollback.json"), JSON.stringify({ passed: true, synthetic: true, failureCode, elapsedMs: Date.now() - started, restoredTableCount: Object.keys(before).length, restoredRowCount: Object.values(before).reduce((sum, rows) => sum + rows.length, 0), configurationHash, backup: path.relative(runRoot, backup), programFilesVerified: Object.keys(initialHashes).length - 1, freshPasswordLogin: true, staleSessionRejected: true, projectReadAndWrite: true, limitations: ["Same candidate with two injected migrations; not a real release pair", "Attachment and content lifecycle recovery have separate LAN fixtures", "No model calls, real business data, OS reboot or multi-machine test"] }, null, 2) + "\n");
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
