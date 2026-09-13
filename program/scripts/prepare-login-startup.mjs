import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
let configuration = "";
try { configuration = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"); } catch { process.exit(0); }
const deliveryMode = /^\s*DELIVERY_MODE\s*=\s*1\s*$/mu.test(configuration);
if (!deliveryMode) process.exit(0);

const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const environment = {
  ...process.env,
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: ".wrangler/logs",
  MINIFLARE_REGISTRY_PATH: ".wrangler/registry",
};
const revokeSessionsSql = new URL("../resources/delivery/revoke-startup-sessions.sql", import.meta.url);
const result = spawnSync(process.execPath, [
  wranglerCli, "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc",
  "--file", fileURLToPath(revokeSessionsSql),
], { cwd: projectRoot, env: environment, stdio: "inherit" });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
console.log("[Liming Zhiyao] Commercial delivery mode: previous login sessions were cleared.");
