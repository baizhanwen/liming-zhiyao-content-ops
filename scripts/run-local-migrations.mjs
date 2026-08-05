import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
