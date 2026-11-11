import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareRuntimeConfiguration } from "./prepare-runtime-configuration.mjs";
import { readLocalRuntimeConfiguration } from "./analyzer-environment-bridge.mjs";
import { waitForLocalRuntimeBridge } from "./local-runtime-endpoint.mjs";
import { evaluateNodeRuntime } from "./node-runtime-policy.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

/** Preserve vinext's arguments while owning only the children started here. */
export async function startWebWithEnvironment({ root = defaultRoot, args = process.argv.slice(2), spawnProcess = spawn, listenSignals = true, verifyBridge = waitForLocalRuntimeBridge } = {}) {
  const compatibility = evaluateNodeRuntime({ version: process.versions.node, arch: process.arch, platform: process.platform });
  if (!compatibility.supported) throw new Error(compatibility.message);
  await prepareRuntimeConfiguration(root);
  const ownConfiguration = readLocalRuntimeConfiguration(root);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ANALYZER_|CONTENT_MODEL_|PROJECT_ASSISTANT_MODEL_|LOCAL_RUNTIME_|MODEL_SETTINGS_)/u.test(name)));
  const environment = { ...inherited, ...ownConfiguration };
  const portArgument = args.findIndex(value => value === "--port");
  const appPort = Number(portArgument >= 0 ? args[portArgument + 1] : args.find(value => value.startsWith("--port="))?.slice(7) || 3000);
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) throw new Error("Invalid local web port.");
  environment.ANALYZER_BASE_URL = `http://127.0.0.1:${appPort}`;
  writeFileSync(path.join(root, ".local", "app.port"), String(appPort) + "\n", { mode: 0o600 });
  const logs = path.join(root, ".local", "logs");
  mkdirSync(logs, { recursive: true });
  const output = openSync(path.join(logs, "environment-manager.log"), "a", 0o600);
  let bridge;
  try { bridge = spawnProcess(process.execPath, [path.join(root, "scripts", "analyzer-environment-bridge.mjs")], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", output, output] }); }
  finally { closeSync(output); }
  bridge.on("error", () => {});
  try { await verifyBridge(root, ownConfiguration, bridge); }
  catch (error) { if (bridge.exitCode === null && !bridge.killed) bridge.kill("SIGTERM"); throw error; }
  const web = spawnProcess(process.execPath, [path.join(root, "node_modules", "vinext", "dist", "cli.js"), "start", ...args], { cwd: root, env: environment, windowsHide: true, stdio: "inherit" });
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    for (const child of [web, bridge]) if (child && child.exitCode === null && !child.killed) child.kill(signal);
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  if (listenSignals) { process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate); }
  const done = new Promise(resolve => {
    web.once("error", () => { stop(); resolve(1); });
    web.once("close", code => {
      stop();
      process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
      resolve(code ?? 0);
    });
    // A bridge already owned by this same checkout may keep serving across a
    // web restart. Port conflicts are logged, never solved by killing a PID.
  });
  return { web, bridge, stop, done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const launched = await startWebWithEnvironment(); process.exitCode = await launched.done; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
