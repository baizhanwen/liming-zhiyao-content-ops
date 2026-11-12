import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";

// These modules belong to the separately launched bridge. Load them at run
// time so editing them cannot restart the Cloudflare RSC/SSR module runners.
function loadRuntimeScript(root: string, name: string) {
  return import(pathToFileURL(path.join(root, "scripts", name)).href);
}

/** Start only this checkout's authenticated loopback bridge with the web app. */
export function analyzerEnvironmentBridge(): Plugin {
  return {
    name: "liming-local-analyzer-environment",
    apply: "serve",
    async config(configuration) {
      // This hook precedes the Cloudflare plugin reading .dev.vars.
      const root = configuration.root || process.cwd();
      const { prepareRuntimeConfiguration } = await loadRuntimeScript(root, "prepare-runtime-configuration.mjs");
      await prepareRuntimeConfiguration(root);
    },
    async configureServer(server) {
      const root = server.config.root;
      const script = path.join(root, "scripts", "analyzer-environment-bridge.mjs");
      if (!existsSync(script)) return;
      const logs = path.join(root, ".local", "logs");
      mkdirSync(logs, { recursive: true });
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address !== "string") writeFileSync(path.join(root, ".local", "app.port"), String(address.port) + "\n", { mode: 0o600 });
      });
      const [{ readLocalRuntimeConfiguration }, { waitForLocalRuntimeBridge }] = await Promise.all([
        loadRuntimeScript(root, "analyzer-environment-bridge.mjs"),
        loadRuntimeScript(root, "local-runtime-endpoint.mjs"),
      ]);
      const output = openSync(path.join(logs, "environment-manager.log"), "a", 0o600);
      const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ["ignore", output, output] });
      closeSync(output);
      child.on("error", () => server.config.logger.warn("Local environment manager could not start; check this project's runtime configuration."));
      try { await waitForLocalRuntimeBridge(root, readLocalRuntimeConfiguration(root), child); }
      catch {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        server.config.logger.warn("本地环境管理服务尚未连接，请查看当前项目的 environment-manager.log。");
      }
      // Killing this child never stops another checkout's bridge or analyzer.
      const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
      server.httpServer?.once("close", stop);
    },
  };
}
