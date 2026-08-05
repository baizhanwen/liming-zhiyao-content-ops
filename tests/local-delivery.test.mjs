import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("local identity is opt-in, loopback-only, and never replaces forwarded identity", async () => {
  const auth = await readFile(new URL("../lib/request-auth.ts", import.meta.url), "utf8");
  assert.match(auth, /LOCAL_DEV_AUTH/);
  assert.match(auth, /hostname === "localhost"/);
  assert.match(auth, /hostname === "127\.0\.0\.1"/);
  assert.match(auth, /hostname === "\[::1\]"/);
  assert.match(auth, /const forwarded = readForwardedIdentity\(request\);[\s\S]*if \(forwarded\) return forwarded;[\s\S]*runtime\.LOCAL_DEV_AUTH/);
});

test("local server stays on loopback and ignores analyzer caches", async () => {
  const vite = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(vite, /host: "127\.0\.0\.1"/);
  assert.match(vite, /services\/analyzer\/\.venv/);
  assert.match(vite, /services\/analyzer\/model-cache/);
});

test("team launch scripts install, migrate, and expose a health check", async () => {
  const [setup, start, packageJson, migrations, health, config] = await Promise.all([
    readFile(new URL("../setup-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../start-local.bat", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-local-migrations.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.local.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(setup, /npm ci/);
  assert.match(start, /db:local:migrate/);
  assert.match(packageJson, /db:local:migrate/);
  assert.match(migrations, /WRANGLER_WRITE_LOGS/);
  assert.match(config, /"migrations_dir": "drizzle"/);
  assert.match(health, /SELECT 1 AS ready/);
  assert.doesNotMatch(health, /ANALYZER_SERVICE_TOKEN|CONTENT_MODEL_API_KEY/);
});

test("Windows batch entry points are ASCII-only and checked out with CRLF", async () => {
  const files = ["setup-local.bat", "start-local.bat", "setup-analyzer.bat", "start-analyzer.bat", "backup-local.bat", "restore-local.bat"];
  const contents = await Promise.all(files.map((file) => readFile(new URL(`../${file}`, import.meta.url), "utf8")));
  for (const [index, content] of contents.entries()) assert.equal(Array.from(content).every((character) => character.codePointAt(0) <= 127), true, `${files[index]} must stay ASCII-safe for cmd.exe`);
  const attributes = await readFile(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.match(attributes, /\*\.bat text eol=crlf/);
});
