import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { LOCAL_RUNTIME_PROTOCOL, runtimeInstallationId, runtimeSourceId } from "./local-runtime-identity.mjs";

export function localRuntimeEndpoint(value) {
  const endpoint = new URL(value);
  const port = Number(endpoint.port);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname)
    || !Number.isInteger(port) || port < 1024 || port > 65535 || endpoint.username || endpoint.password
    || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Invalid local environment endpoint.");
  endpoint.hostname = "127.0.0.1";
  return endpoint;
}

export async function probeLocalRuntimeBridge(root, configuration) {
  try {
    const endpoint = localRuntimeEndpoint(configuration.LOCAL_RUNTIME_URL);
    const installationId = runtimeInstallationId(root);
    const sourceId = runtimeSourceId(root);
    const response = await fetch(new URL("/identity", endpoint), {
      headers: { authorization: `Bearer ${configuration.LOCAL_RUNTIME_TOKEN}`, "x-liming-installation": installationId, "x-liming-source": sourceId },
      signal: AbortSignal.timeout(700), redirect: "manual",
    });
    if (!response.ok) return false;
    const identity = await response.json();
    return identity.protocol === LOCAL_RUNTIME_PROTOCOL && identity.installationId === installationId && identity.sourceId === sourceId;
  } catch { return false; }
}

async function reservePort(port) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", error => error.code === "EADDRINUSE" ? resolve(null) : reject(error));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

export async function selectLocalRuntimeUrl(root, configuration) {
  const endpoint = localRuntimeEndpoint(configuration.LOCAL_RUNTIME_URL || "http://127.0.0.1:3001");
  if (await probeLocalRuntimeBridge(root, { ...configuration, LOCAL_RUNTIME_URL: endpoint.origin })) return endpoint.origin;
  const port = await reservePort(Number(endpoint.port)) ?? await reservePort(0);
  return `http://127.0.0.1:${port}`;
}

export async function waitForLocalRuntimeBridge(root, configuration, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeLocalRuntimeBridge(root, configuration)) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) break;
    await delay(50);
  }
  throw new Error("本项目的环境管理服务未能启动或版本不匹配，请停止旧版后台后重新启动本项目。");
}
