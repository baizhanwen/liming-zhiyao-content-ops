import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_RUNTIME_PROTOCOL = 2;

export function runtimeInstallationId(root) {
  let canonical = path.resolve(root);
  try { canonical = realpathSync(canonical); } catch { /* A not-yet-created fixture still has a stable identity. */ }
  canonical = canonical.replace(/[\\/]+$/u, "");
  if (process.platform === "win32") canonical = canonical.toUpperCase();
  return createHash("sha256").update(canonical).digest("hex");
}

// Only executable source participates. Configuration, business data and caches never do.
export function runtimeSourceId(root) {
  const hash = createHash("sha256");
  for (const name of [
    "scripts/local-runtime-identity.mjs", "scripts/local-runtime-endpoint.mjs",
    "scripts/analyzer-environment-bridge.mjs", "scripts/analyzer_local_runtime.py",
    "scripts/analyzer-windows-control.ps1", "scripts/analyzer-windows-identity.ps1",
    "scripts/start-analyzer-background.ps1", "scripts/run-analyzer-supervisor.ps1",
    "scripts/start-web-with-environment.mjs", "scripts/prepare-runtime-configuration.mjs",
    "scripts/local-web-identity.ps1", "scripts/run-web-guard.ps1",
    "build/analyzer-environment-plugin.ts", "lib/analyzer-environment.ts",
    "app/api/health/route.ts", "lib/build-info.ts",
    "services/analyzer/liming_analyzer/douyin_collector/adapter.py",
    "services/analyzer/liming_analyzer/sources.py",
  ]) {
    hash.update(name + "\0");
    try { hash.update(readFileSync(path.join(root, name))); } catch (error) { if (error.code !== "ENOENT") throw error; hash.update("missing"); }
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = process.argv[3] || fileURLToPath(new URL("..", import.meta.url));
  if (process.argv[2] === "--source-id") console.log(runtimeSourceId(root));
  else if (process.argv[2] === "--installation-id") console.log(runtimeInstallationId(root));
  else process.exitCode = 2;
}
