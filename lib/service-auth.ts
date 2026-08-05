import { env } from "cloudflare:workers";
import { apiError } from "./api-response";

const WORKER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;

async function sha256(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function constantTimeSecretEqual(actual: string, expected: string) {
  const [actualHash, expectedHash] = await Promise.all([sha256(actual), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) difference |= actualHash[index] ^ expectedHash[index];
  return difference === 0;
}

export async function requireAnalyzerService(request: Request) {
  const runtimeEnv = env as typeof env & { ANALYZER_SERVICE_TOKEN?: string };
  const expected = runtimeEnv.ANALYZER_SERVICE_TOKEN?.trim();
  if (!expected) return { error: apiError("SERVICE_AUTH_UNAVAILABLE", "分析服务凭据尚未配置。", 503) } as const;

  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!actual || !(await constantTimeSecretEqual(actual, expected))) {
    return { error: apiError("SERVICE_AUTH_REQUIRED", "分析服务凭据无效。", 401) } as const;
  }
  return { authenticated: true } as const;
}

export function normalizeWorkerId(value: unknown) {
  return typeof value === "string" && WORKER_ID_PATTERN.test(value) ? value : null;
}

export function normalizeLeaseSeconds(value: unknown) {
  const seconds = typeof value === "number" && Number.isInteger(value) ? value : 120;
  return Math.min(300, Math.max(30, seconds));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
