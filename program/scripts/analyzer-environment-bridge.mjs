import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOCAL_RUNTIME_PROTOCOL, runtimeInstallationId, runtimeSourceId } from "./local-runtime-identity.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const actions = new Set(["setup", "start", "stop", "check"]);

export function parseLocalRuntimeConfiguration(content) {
  const values = {};
    for (const line of content.split(/\r\n|\n|\r/u)) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
      if (!match) continue;
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
      else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      values[match[1]] = value;
    }
  return values;
}

export function readLocalRuntimeConfiguration(root = projectRoot) {
  try { return parseLocalRuntimeConfiguration(readFileSync(path.join(root, ".dev.vars"), "utf8")); }
  catch { return {}; }
}

export function redactRuntimeLine(value, configuration = {}, root = projectRoot) {
  let line = String(value);
  for (const [name, secret] of Object.entries(configuration)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/u.test(name) && typeof secret === "string" && secret.length >= 6) line = line.split(secret).join("[已隐藏]");
  }
  line = line.replace(/Bearer\s+\S+/giu, "Bearer [已隐藏]")
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/gu, "[已隐藏]")
    .replace(/([?&](?:key|api_key|token|access_token|signature)=)[^&\s]+/giu, "$1[已隐藏]");
  for (const [directory, label] of [[path.resolve(root), "[本项目]"], [os.homedir(), "[用户目录]"]]) if (directory) line = line.split(directory).join(label);
  return line.slice(0, 1500);
}

function secretMatches(actual, expected) {
  if (!actual || !expected || expected.length < 32) return false;
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}

function pythonCommand(root) {
  const executable = path.join(root, "services", "analyzer", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (existsSync(executable)) return [executable];
  const localPython = path.join(root, ".local", "python311", "python.exe");
  if (process.platform === "win32" && existsSync(localPython)) return [localPython];
  return process.platform === "win32" ? ["py", "-3.11"] : ["python3.11"];
}

function streamRuntimeProcess(command, args, { root, onLine, children, timeoutMs, baseUrl, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(baseUrl ? { ANALYZER_BASE_URL: baseUrl } : {}), PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    children.add(child);
    let lastJson = null;
    const consume = line => {
      if (!line.trim()) return;
      try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lastJson = parsed; } catch { /* Setup subprocesses also print ordinary progress lines. */ }
      onLine(line);
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      stream.on("data", chunk => {
        pending += decoder.write(chunk);
        const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? "";
        for (const line of lines) consume(line);
        if (pending.length > 16000) { consume(pending.slice(0, 16000)); pending = ""; }
      });
      stream.on("end", () => { pending += decoder.end(); if (pending) consume(pending); });
    }
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", error => { clearTimeout(timeout); children.delete(child); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); children.delete(child);
      resolve({ code: code ?? 1, signal, result: lastJson });
    });
  });
}

export async function runRuntimeCommand(action, { root = projectRoot, onLine = () => {}, children = new Set(), spawnProcess = spawn, baseUrl } = {}) {
  if (![...actions, "status"].includes(action)) throw new Error("Unsupported runtime action");
  if (action === "setup" && process.platform === "win32") {
    const [probePython, ...probePrefix] = pythonCommand(root);
    const probe = spawnSync(probePython, [...probePrefix, "-I", "-c", "import sys; assert sys.version_info[:2] == (3,11) and sys.maxsize > 2**32"], { cwd: root, windowsHide: true, timeout: 10_000, stdio: "ignore" });
    if (probe.status !== 0) {
      onLine("正在为本项目准备 Python 3.11（验证官方发布者签名）…");
      const installed = await streamRuntimeProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "install-python311.ps1"), "-TargetDirectory", path.join(root, ".local", "python311")], { root, onLine, children, spawnProcess, timeoutMs: 20 * 60_000 });
      if (installed.code !== 0) return installed;
    }
  }
  const [python, ...prefix] = pythonCommand(root);
  return streamRuntimeProcess(python, [...prefix, path.join(root, "scripts", "analyzer_local_runtime.py"), action, ...(baseUrl ? ["--base-url", baseUrl] : [])], { root, onLine, children, spawnProcess, baseUrl, timeoutMs: action === "setup" ? 45 * 60_000 : action === "check" ? 240_000 : 90_000 });
}

function applicationBaseUrl(root, configuration) {
  try {
    const port = Number(readFileSync(path.join(root, ".local", "app.port"), "utf8").trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) return `http://127.0.0.1:${port}`;
  } catch { /* Direct CLI startup can provide the address in the environment. */ }
  const address = new URL(process.env.ANALYZER_BASE_URL || configuration.ANALYZER_BASE_URL || "http://127.0.0.1:3000");
  if (address.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.username || address.password || address.pathname !== "/" || address.search || address.hash) throw new Error("Invalid local application address");
  return address.origin;
}

function publicRuntimeStatus(result, redact) {
  const data = result && typeof result === "object" ? result : {};
  return {
    available: true,
    workerRunning: data.workerRunning === true,
    processRunning: data.processRunning === true || data.workerRunning === true,
    restartRequired: data.restartRequired === true,
    ready: data.ready === true,
    checks: Array.isArray(data.checks) ? data.checks.slice(0, 30).map((check, index) => ({
      id: typeof check.id === "string" ? check.id.slice(0, 80) : String(index),
      label: redact(check.label ?? check.name ?? "运行环境"),
      status: ["ready", "missing", "error", "checking"].includes(check.status) ? check.status : check.ok ? "ready" : "missing",
      ...(typeof check.message === "string" ? { message: redact(check.message) } : {}),
    })) : [],
    ...(typeof data.message === "string" ? { message: redact(data.message) } : {}),
  };
}

export function createAnalyzerEnvironmentBridge({ root = projectRoot, configuration = () => readLocalRuntimeConfiguration(root), run, persist = true } = {}) {
  const children = new Set();
  const installationId = runtimeInstallationId(root);
  const sourceId = runtimeSourceId(root);
  const execute = run ?? ((action, options) => runRuntimeCommand(action, { root, children, baseUrl: applicationBaseUrl(root, configuration()), ...options }));
  let job = null;
  let statusCache = null;
  let cachedAt = 0;
  let reading = null;
  const statePath = path.join(root, ".local", "environment-manager.json");
  if (persist) {
    try {
      const previous = JSON.parse(readFileSync(statePath, "utf8"));
      if (previous?.job && actions.has(previous.job.action)) {
        job = previous.job;
        if (job.status === "running") job = { ...job, status: "failed", error: "上次环境任务被中断，请重新检查后继续。" };
      }
    } catch { /* First run has no job history. */ }
  }
  const redact = line => redactRuntimeLine(line, configuration(), root);
  const save = () => {
    if (!persist) return;
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ job }, null, 2) + "\n", { mode: 0o600 });
  };
  const readStatus = async () => {
    if (statusCache && Date.now() - cachedAt < 1000) return statusCache;
    if (reading) return reading;
    reading = (async () => {
      try {
        const checked = await execute("status", { onLine: () => {} });
        statusCache = publicRuntimeStatus(checked.result, redact);
        if (checked.code !== 0) statusCache.message = "环境状态检查未完成，请查看运行任务或重新检查。";
      } catch {
        statusCache = { available: true, ready: false, workerRunning: false, checks: [{ id: "python", label: "Python 3.11", status: "missing", message: process.platform === "win32" ? "尚未找到 Python 3.11，可点击一键配置环境自动准备。" : "尚未找到 Python 3.11，请先准备本机 Python 3.11 后重新检查。" }] };
      }
      cachedAt = Date.now();
      return statusCache;
    })();
    try { return await reading; } finally { reading = null; }
  };
  const snapshot = async () => ({ ...await readStatus(), ...(job ? { job } : {}) });
  function startJob(action) {
    if (job?.status === "running") return false;
    job = { id: randomUUID(), action, status: "running", logTail: [], startedAt: new Date().toISOString() };
    save();
    const current = job;
    void (async () => {
      try {
        const onLine = line => { current.logTail.push(redact(line)); current.logTail = current.logTail.slice(-70); save(); };
        let result = await execute(action, { onLine });
        if (action === "setup" && result.result?.stopRequired === true) {
          onLine("正在停止本项目分析服务，以便配置运行环境…");
          const stopped = await execute("stop", { onLine });
          result = stopped.code === 0 ? await execute("setup", { onLine }) : stopped;
        }
        if (action === "setup" && result.code === 0) {
          onLine("环境准备完成，正在启动本项目视频分析服务…");
          result = await execute("start", { onLine });
        }
        current.status = result.code === 0 ? "succeeded" : "failed";
        if (result.code !== 0) current.error = typeof result.result?.message === "string" ? redact(result.result.message) : "操作没有完成，请根据运行日志修复后重试。";
      } catch {
        current.status = "failed";
        current.error = "环境操作无法启动，请确认 Python 3.11 已安装后重试。";
      } finally { cachedAt = 0; save(); }
    })();
    return true;
  }
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    try {
      const address = request.socket.remoteAddress ?? "";
      const host = new URL(`http://${request.headers.host ?? "invalid"}`);
      const actualPort = String(request.socket.localPort);
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) || !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) || host.port !== actualPort || host.username || host.password || request.headers.origin) {
        send(403, { error: { code: "LOCAL_ONLY", message: "环境控制仅允许本项目服务访问。" } }); return;
      }
      const authorization = request.headers.authorization ?? "";
      if (!secretMatches(authorization.startsWith("Bearer ") ? authorization.slice(7) : "", configuration().LOCAL_RUNTIME_TOKEN ?? "")) {
        send(401, { error: { code: "AUTH_REQUIRED", message: "环境控制凭据无效。" } }); return;
      }
      if (request.headers["x-liming-installation"] !== installationId || request.headers["x-liming-source"] !== sourceId) {
        send(409, { error: { code: "RUNTIME_INSTALLATION_MISMATCH", message: "环境管理服务属于另一安装或旧版本，请重新启动当前项目。" } }); return;
      }
      const url = new URL(request.url ?? "/", host);
      if (url.pathname === "/identity" && request.method === "GET") { send(200, { protocol: LOCAL_RUNTIME_PROTOCOL, installationId, sourceId }); return; }
      if (url.pathname !== "/environment") { send(404, { error: { code: "NOT_FOUND", message: "接口不存在。" } }); return; }
      if (request.method === "GET") { send(200, await snapshot()); return; }
      if (request.method !== "POST") { send(405, { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该请求方式。" } }); return; }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (body.length > 4096) { send(413, { error: { code: "BODY_TOO_LARGE", message: "请求过大。" } }); return; }
      }
      let input;
      try { input = JSON.parse(body); } catch { send(400, { error: { code: "INVALID_ACTION", message: "环境操作格式无效。" } }); return; }
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "action") || !actions.has(input.action)) {
        send(400, { error: { code: "INVALID_ACTION", message: "只允许配置、启动、停止或检查环境。" } }); return;
      }
      if (!startJob(input.action)) { send(409, { error: { code: "RUNTIME_BUSY", message: "已有环境任务正在执行，请等待完成。" } }); return; }
      send(202, await snapshot());
    } catch { if (!response.headersSent) send(500, { error: { code: "RUNTIME_ERROR", message: "环境控制暂时无法完成请求。" } }); else response.end(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("close", () => { for (const child of children) child.kill("SIGTERM"); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const configuration = readLocalRuntimeConfiguration();
  if (!configuration.LOCAL_RUNTIME_TOKEN || configuration.LOCAL_RUNTIME_TOKEN.length < 32) {
    console.error("Local environment manager is not configured."); process.exitCode = 1;
  } else {
    const server = createAnalyzerEnvironmentBridge();
    server.on("error", error => { console.error(error.code === "EADDRINUSE" ? "Local environment manager port is already in use." : "Local environment manager could not start."); process.exitCode = 1; });
    let endpoint;
    try {
      endpoint = new URL(configuration.LOCAL_RUNTIME_URL);
      if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || !/^\d+$/u.test(endpoint.port) || Number(endpoint.port) < 1024 || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error();
    } catch { console.error("Local environment manager address is invalid."); process.exitCode = 1; }
    if (endpoint && !process.exitCode) server.listen(Number(endpoint.port), "127.0.0.1", () => console.log(`Local environment manager is listening on 127.0.0.1:${endpoint.port}.`));
    const close = () => server.close(() => process.exit(0));
    process.once("SIGINT", close); process.once("SIGTERM", close);
  }
}
