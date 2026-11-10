import { env } from "cloudflare:workers";

export type AnalyzerEnvironmentAction = "setup" | "start" | "stop" | "check";
export type AnalyzerEnvironmentSnapshot = {
  available: boolean;
  ready: boolean;
  workerRunning: boolean;
  checks: Array<{ id: string; label: string; status: "ready" | "missing" | "error" | "checking"; message?: string }>;
  job?: { id: string; action: string; status: "running" | "succeeded" | "failed"; logTail: string[]; startedAt: string; error?: string };
  message?: string;
};

export class AnalyzerEnvironmentError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

const offline = (): AnalyzerEnvironmentSnapshot => ({ available: false, ready: false, workerRunning: false, checks: [], message: "本项目的环境管理服务尚未连接，请重新启动本地项目后检查。" });

function cleanText(value: unknown, secret: string) {
  return typeof value === "string" ? value.split(secret).join("[已隐藏]").replace(/Bearer\s+\S+/giu, "Bearer [已隐藏]").slice(0, 1500) : "";
}

function publicSnapshot(value: unknown, secret: string): AnalyzerEnvironmentSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid environment response");
  const data = value as Record<string, unknown>;
  const text = (input: unknown) => cleanText(input, secret);
  const snapshot: AnalyzerEnvironmentSnapshot = {
    available: data.available === true, ready: data.ready === true, workerRunning: data.workerRunning === true,
    checks: Array.isArray(data.checks) ? data.checks.slice(0, 30).map((item: Record<string, unknown>, index) => ({
      id: text(item.id) || String(index), label: text(item.label),
      status: ["ready", "missing", "error", "checking"].includes(String(item.status)) ? item.status as "ready" | "missing" | "error" | "checking" : "error",
      ...(item.message ? { message: text(item.message) } : {}),
    })) : [],
    ...(data.message ? { message: text(data.message) } : {}),
  };
  const job = data.job as Record<string, unknown> | undefined;
  if (job && ["running", "succeeded", "failed"].includes(String(job.status))) snapshot.job = {
    id: text(job.id), action: text(job.action), status: job.status as "running" | "succeeded" | "failed", startedAt: text(job.startedAt),
    logTail: Array.isArray(job.logTail) ? job.logTail.slice(-70).map(text) : [], ...(job.error ? { error: text(job.error) } : {}),
  };
  return snapshot;
}

export function isLocalEnvironmentRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

export async function requestAnalyzerEnvironment(action?: AnalyzerEnvironmentAction): Promise<AnalyzerEnvironmentSnapshot> {
  const runtime = env as typeof env & { LOCAL_RUNTIME_URL?: string; LOCAL_RUNTIME_TOKEN?: string };
  const token = runtime.LOCAL_RUNTIME_TOKEN?.trim() ?? "";
  let endpoint: URL;
  try {
    endpoint = new URL(runtime.LOCAL_RUNTIME_URL ?? "");
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || endpoint.port !== "3001" || endpoint.username || endpoint.password || token.length < 32) throw new Error("Unavailable local runtime");
    endpoint = new URL("/environment", endpoint);
  } catch { if (action) throw new AnalyzerEnvironmentError("RUNTIME_UNAVAILABLE", offline().message!, 503); return offline(); }
  try {
    const response = await fetch(endpoint, {
      method: action ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(action ? { "content-type": "application/json" } : {}) },
      ...(action ? { body: JSON.stringify({ action }) } : {}),
      signal: AbortSignal.timeout(25_000), redirect: "manual",
    });
    if (response.status === 409) throw new AnalyzerEnvironmentError("RUNTIME_BUSY", "已有环境任务正在执行，请等待完成。", 409);
    if (!response.ok) throw new Error("Local runtime unavailable");
    return publicSnapshot(await response.json(), token);
  } catch (error) {
    if (error instanceof AnalyzerEnvironmentError) throw error;
    if (action) throw new AnalyzerEnvironmentError("RUNTIME_UNAVAILABLE", "环境管理服务暂未连接，请重新启动本项目后重试。", 503);
    return offline();
  }
}
