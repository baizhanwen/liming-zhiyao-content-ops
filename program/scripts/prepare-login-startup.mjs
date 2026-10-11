import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.platform === "win32" && !process.argv.includes("--locked")) {
  const guard = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(projectRoot, "scripts/run-startup-guard.ps1"), "-NodePath", process.execPath,
    ...(process.argv.includes("--guarded") ? ["-WebAlreadyLocked"] : [])], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
  if (guard.error) throw guard.error;
  process.exit(guard.status ?? 1);
}
let configuration = "";
try { configuration = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"); } catch { process.exit(0); }
const flagEnabled = (name) => new RegExp(`^\\s*${name}\\s*=\\s*(?:1|"1"|'1')\\s*(?:#.*)?$`, "mu").test(configuration);
const deliveryMode = flagEnabled("DELIVERY_MODE");
const configuredLanOrigin = configuration.match(/^\s*LAN_ACCESS_ORIGIN\s*=\s*(.*?)\s*$/mu)?.[1]
  ?.replace(/\s+#.*$/u, "").replace(/^(['"])(.*)\1$/u, "$2").trim();
const lanMode = process.env.LAN_MODE?.trim() === "1" || flagEnabled("LAN_MODE")
  || Boolean(process.env.LAN_ACCESS_ORIGIN?.trim() || configuredLanOrigin);
// Password-based local installations need the same fresh login as deliveries.
// Only an explicitly enabled development identity skips session revocation.
const skipSessionRevocation = !deliveryMode && !lanMode && flagEnabled("LOCAL_DEV_AUTH");

const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const environment = {
  ...process.env,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: ".wrangler/logs",
  MINIFLARE_REGISTRY_PATH: ".wrangler/registry",
};
const recoverySql = new URL("../resources/delivery/recover-startup-work.sql", import.meta.url);
const recovered = spawnSync(process.execPath, [wranglerCli, "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--file", fileURLToPath(recoverySql)], { cwd: projectRoot, env: environment, stdio: "inherit" });
if (recovered.error) throw recovered.error;
if ((recovered.status ?? 1) !== 0) process.exit(recovered.status ?? 1);
console.log("[Liming Zhiyao] Interrupted web work was marked failed. Drafts and model request records were preserved; no model retry was dispatched.");
if (skipSessionRevocation) process.exit(0);
const revokeSessionsSql = new URL("../resources/delivery/revoke-startup-sessions.sql", import.meta.url);
const result = spawnSync(process.execPath, [
  wranglerCli, "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc",
  "--file", fileURLToPath(revokeSessionsSql),
], { cwd: projectRoot, env: environment, stdio: "inherit" });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
console.log("[Liming Zhiyao] Previous login sessions were cleared. Please sign in again.");
