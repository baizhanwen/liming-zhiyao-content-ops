import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
// workerd's Windows SQLite backend still observes MAX_PATH even when Node
// can create longer paths. Fail clearly before opening an unusable database.
const sqlitePath = path.join(projectRoot, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject", `${"0".repeat(64)}.sqlite-wal`);
if (process.platform === "win32" && sqlitePath.length >= 260) {
  console.error("[ERROR] Installation path is too long for the local database. Move the complete project to a shorter path, such as C:\\LimingZhiyao, then run setup-local.bat again. Existing data must remain with the project folder.");
  process.exit(1);
}

// Normal direct invocations share the maintenance gate. The guard re-enters
// with --guarded; factory reset already owns that gate for its whole transaction.
if (process.platform === "win32" && !process.argv.includes("--guarded")) {
  const guarded = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(projectRoot, "scripts/run-migration-guard.ps1"), "-NodePath", process.execPath,
  ], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
  if (guarded.error) throw guarded.error;
  process.exit(guarded.status ?? 1);
}

const wranglerCli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const environment = {
  ...process.env,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: ".wrangler/logs",
  MINIFLARE_REGISTRY_PATH: ".wrangler/registry",
};

const result = spawnSync(
  process.execPath,
  [wranglerCli, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.local.jsonc"],
  { cwd: new URL("..", import.meta.url), env: environment, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
