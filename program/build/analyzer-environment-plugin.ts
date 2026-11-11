import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { prepareRuntimeConfiguration } from "../scripts/prepare-runtime-configuration.mjs";
import { readLocalRuntimeConfiguration } from "../scripts/analyzer-environment-bridge.mjs";
import { waitForLocalRuntimeBridge } from "../scripts/local-runtime-endpoint.mjs";

/** Start only this checkout's authenticated loopback bridge with the web app. */
export function analyzerEnvironmentBridge(): Plugin {
  return {
    name: "liming-local-analyzer-environment",
    apply: "serve",
    async config(configuration) {
      // This hook precedes the Cloudflare plugin reading .dev.vars.
      await prepareRuntimeConfiguration(configuration.root || process.cwd());
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
      const output = openSync(path.join(logs, "environment-manager.log"), "a", 0o600);
      const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ["ignore", output, output] });
      closeSync(output);
      child.on("error", () => server.config.logger.warn("Local environment manager could not start; check this project's runtime configuration."));
      try { await waitForLocalRuntimeBridge(root, readLocalRuntimeConfiguration(root), child); }
      catch (error) { if (child.exitCode === null) child.kill("SIGTERM"); throw error; }
      // Killing this child never stops another checkout's bridge or analyzer.
      const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
      server.httpServer?.once("close", stop);
    },
  };
}
