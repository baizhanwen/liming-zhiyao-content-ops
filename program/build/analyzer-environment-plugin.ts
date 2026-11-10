import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { prepareRuntimeConfiguration } from "../scripts/prepare-runtime-configuration.mjs";

/** Start only this checkout's authenticated loopback bridge with the web app. */
export function analyzerEnvironmentBridge(): Plugin {
  return {
    name: "liming-local-analyzer-environment",
    apply: "serve",
    async config(configuration) {
      // This hook precedes the Cloudflare plugin reading .dev.vars.
      await prepareRuntimeConfiguration(configuration.root || process.cwd());
    },
    configureServer(server) {
      const root = server.config.root;
      const script = path.join(root, "scripts", "analyzer-environment-bridge.mjs");
      if (!existsSync(script)) return;
      const logs = path.join(root, ".local", "logs");
      mkdirSync(logs, { recursive: true });
      const output = openSync(path.join(logs, "environment-manager.log"), "a", 0o600);
      const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, stdio: ["ignore", output, output] });
      closeSync(output);
      child.on("error", () => server.config.logger.warn("Local environment manager could not start; check this project's runtime configuration."));
      // Killing this child never stops another checkout's bridge or analyzer.
      const stop = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
      server.httpServer?.once("close", stop);
    },
  };
}
