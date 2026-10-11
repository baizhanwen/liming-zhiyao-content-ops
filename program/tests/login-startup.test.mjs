import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

const root = new URL("../", import.meta.url);

for (const [label, configuration, revoke, lanEnvironment = {}] of [
  ["local password login", "LOCAL_DEV_AUTH=0\nDELIVERY_MODE=0\n", true],
  ["default password login", "DELIVERY_MODE=0\n", true],
  ["explicit development bypass", "LOCAL_DEV_AUTH=1\nDELIVERY_MODE=0\n", false],
  ["quoted development bypass", 'LOCAL_DEV_AUTH="1" # developer only\n', false],
  ["delivery overrides development bypass", "LOCAL_DEV_AUTH=1\nDELIVERY_MODE=1\n", true],
  ["quoted delivery mode", "LOCAL_DEV_AUTH=1\nDELIVERY_MODE='1' # customer\n", true],
  ["LAN environment overrides development bypass", "LOCAL_DEV_AUTH=1\nDELIVERY_MODE=0\n", true, { LAN_MODE: "1" }],
  ["LAN origin environment overrides development bypass", "LOCAL_DEV_AUTH=1\nDELIVERY_MODE=0\n", true, { LAN_ACCESS_ORIGIN: "http://192.168.1.10:3000" }],
  ["LAN configuration overrides development bypass", "LOCAL_DEV_AUTH=1\nLAN_MODE='1'\n", true],
  ["LAN origin configuration overrides development bypass", 'LOCAL_DEV_AUTH=1\nLAN_ACCESS_ORIGIN="http://192.168.1.10:3000"\n', true],
  ["empty LAN origin preserves explicit loopback bypass", 'LOCAL_DEV_AUTH=1\nLAN_ACCESS_ORIGIN=""\n', false],
]) {
  test(`startup session revocation: ${label}`, t => {
    const tempRoot = path.resolve(tmpdir());
    const dir = mkdtempSync(path.join(tempRoot, "liming-login-startup-"));
    t.after(() => {
      const relative = path.relative(tempRoot, path.resolve(dir));
      assert.ok(relative.startsWith("liming-login-startup-") && !relative.includes(path.sep) && !path.isAbsolute(relative));
      rmSync(dir, { recursive: true, force: true });
    });
    for (const relative of ["scripts", "resources/delivery", "node_modules/wrangler/bin"]) mkdirSync(path.join(dir, relative), { recursive: true });
    for (const relative of ["scripts/prepare-login-startup.mjs", "resources/delivery/revoke-startup-sessions.sql"]) copyFileSync(new URL(relative, root), path.join(dir, relative));
    writeFileSync(path.join(dir, ".dev.vars"), configuration);
    writeFileSync(path.join(dir, "node_modules/wrangler/bin/wrangler.js"), `
      const { DatabaseSync } = require("node:sqlite");
      const { readFileSync, writeFileSync } = require("node:fs");
      const db = new DatabaseSync("synthetic.sqlite");
      writeFileSync("cli-args.json", JSON.stringify(process.argv.slice(2)));
      db.exec(readFileSync(process.argv[process.argv.indexOf("--file") + 1], "utf8"));
      db.close();
    `);
    const db = new DatabaseSync(path.join(dir, "synthetic.sqlite"));
    try {
      db.exec("CREATE TABLE local_sessions (id TEXT); INSERT INTO local_sessions VALUES ('old-session'); CREATE TABLE local_login_attempts (email TEXT); INSERT INTO local_login_attempts VALUES ('synthetic@example.invalid'); CREATE TABLE business_data (id TEXT); INSERT INTO business_data VALUES ('keep');");
      const result = spawnSync(process.execPath, [path.join(dir, "scripts/prepare-login-startup.mjs")], { cwd: dir, env: { ...process.env, LAN_MODE: "0", LAN_ACCESS_ORIGIN: "", ...lanEnvironment }, encoding: "utf8", timeout: 15000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(db.prepare("SELECT count(*) AS count FROM local_sessions").get().count, revoke ? 0 : 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM business_data").get().count, 1);
      assert.equal(existsSync(path.join(dir, "cli-args.json")), revoke);
      if (revoke) {
        const args = JSON.parse(readFileSync(path.join(dir, "cli-args.json"), "utf8"));
        assert.ok(args.includes("--local"));
        assert.equal(args[args.indexOf("--config") + 1], "wrangler.local.jsonc");
      }
    } finally { db.close(); }
  });
}

test("startup invalidates a previously valid cookie and a fresh login works", async t => {
  const f = runtimeFixture(t);
  const initialized = await f.initialize();
  const user = f.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(initialized.email);
  const auth = f.load("lib/local-auth.ts");
  const request = new Request("http://127.0.0.1:3000/api/auth/session");
  const oldCookie = await auth.createLocalSession(user.id, request);
  const oldRequest = new Request(request.url, { headers: { cookie: oldCookie.split(";")[0] } });
  assert.ok(await auth.readLocalSessionIdentity(oldRequest));
  f.sqlite.exec(readFileSync(new URL("resources/delivery/revoke-startup-sessions.sql", root), "utf8"));
  assert.equal(await auth.readLocalSessionIdentity(oldRequest), null);
  assert.ok(await auth.verifyLocalLogin(initialized.email, "synthetic-password-only"));
  const freshCookie = await auth.createLocalSession(user.id, request);
  assert.ok(await auth.readLocalSessionIdentity(new Request(request.url, { headers: { cookie: freshCookie.split(";")[0] } })));
});
