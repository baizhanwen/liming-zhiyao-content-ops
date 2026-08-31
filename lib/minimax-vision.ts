export type VisionProbeMetadata = {
  status: "passed" | "failed";
  checkedAt: string;
  fingerprint: string;
  provider: "MiniMax Token Plan";
  model: "understand_image";
  adapter: "understand_image_api_preflight";
  endpointConnected: boolean;
  imageTestPassed: boolean;
  observationCount: number;
  httpStatus: number | null;
  responseType: string;
  requestId: string | null;
  providerCode: number | null;
  message: string;
};

type Runtime = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const PROBE_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAIAAAAVRe7OAAABjUlEQVR42u3dvVECURSA0adDG5ZgEQ4ZMbGhmc0YGhITk0ERtEAjVoDB+9l37+75YmSvHO8uwwzuy/v3rWyp+8/Hpn7f1yLAAizAAizAAizAgAVYgAVYgNXQzkswqMfx8P8D3s4XwGtDffbgcdiAJ9A++/ERzIAn045mBhyCdhyzd9GxdLs/P+CIuh2P4hQdkbbj6doGx9XtclzA0XUbjw64+Cxak9e3ZQbAOXSrJwGcRrduHsCuwdY381SAbbD1zTwbYBtsfTNPCNgGC7AAuwDPmROwDRZgARZgARZgAQYswAKctmW+e7/MnIBtsAALsMvwnAkB22BLnHk2wDbYEmeeCrANtsSZ5wGcybhiEsBpjOtmAOwarABLXH10wAmMW47rXxnWvNaLfbel/U/KBsdd5S5HARzUuNfzO0WHO137j++rZXbPhtUyu+tKvguz+yZ5F1Z8kiXAAgxYxd1HN9f+9zPyeNevkw0WYMACLMACLMACrOKDjtLzkwQbLMACLMACDFiABViABVgd+gN4THwdQQ9FfgAAAABJRU5ErkJggg==";

function value(runtime: Runtime, name: string) {
  const candidate = runtime[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function safeMessage(candidate: unknown) {
  return String(candidate || "")
    .replace(/sk-cp[-_A-Za-z0-9]{8,}/gi, "<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .slice(0, 500);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isMiniMaxTokenPlanKey(candidate: unknown) {
  return typeof candidate === "string" && /^sk-cp(?:[-_]|$)/i.test(candidate.trim());
}

export function normalizeMiniMaxTokenPlanHost(candidate: unknown) {
  const fallback = "https://api.minimaxi.com";
  if (typeof candidate !== "string" || !candidate.trim()) return fallback;
  try {
    const parsed = new URL(candidate.trim());
    if (parsed.protocol !== "https:" || !["api.minimaxi.com", "api.minimax.io"].includes(parsed.hostname.toLowerCase())) return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export function visionConfigurationFingerprint(runtime: Runtime) {
  const source = [
    value(runtime, "ANALYZER_VISION_PROVIDER").toLowerCase(),
    normalizeMiniMaxTokenPlanHost(value(runtime, "ANALYZER_VISION_BASE_URL")),
    value(runtime, "ANALYZER_VISION_MODEL").toLowerCase(),
    value(runtime, "ANALYZER_VISION_API_KEY"),
  ].join("\u001f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseVisionProbeMetadata(candidate: unknown): VisionProbeMetadata | null {
  const row = record(candidate);
  if (!row || (row.status !== "passed" && row.status !== "failed")) return null;
  if (typeof row.checkedAt !== "string" || typeof row.fingerprint !== "string") return null;
  return {
    status: row.status,
    checkedAt: row.checkedAt,
    fingerprint: row.fingerprint,
    provider: "MiniMax Token Plan",
    model: "understand_image",
    adapter: "understand_image_api_preflight",
    endpointConnected: row.endpointConnected === true,
    imageTestPassed: row.imageTestPassed === true,
    observationCount: typeof row.observationCount === "number" ? row.observationCount : 0,
    httpStatus: typeof row.httpStatus === "number" ? row.httpStatus : null,
    responseType: typeof row.responseType === "string" ? row.responseType : "unknown",
    requestId: typeof row.requestId === "string" ? row.requestId : null,
    providerCode: typeof row.providerCode === "number" ? row.providerCode : null,
    message: typeof row.message === "string" ? safeMessage(row.message) : "",
  };
}

export async function probeMiniMaxTokenPlanVision(
  runtime: Runtime,
  fetcher: FetchLike = fetch,
): Promise<VisionProbeMetadata> {
  const checkedAt = new Date().toISOString();
  const fingerprint = visionConfigurationFingerprint(runtime);
  const apiKey = value(runtime, "ANALYZER_VISION_API_KEY");
  const apiHost = normalizeMiniMaxTokenPlanHost(value(runtime, "ANALYZER_VISION_BASE_URL"));
  const base = {
    checkedAt,
    fingerprint,
    provider: "MiniMax Token Plan" as const,
    model: "understand_image" as const,
    adapter: "understand_image_api_preflight" as const,
  };
  if (!isMiniMaxTokenPlanKey(apiKey)) {
    return {
      ...base,
      status: "failed",
      endpointConnected: false,
      imageTestPassed: false,
      observationCount: 0,
      httpStatus: null,
      responseType: "configuration",
      requestId: null,
      providerCode: null,
      message: "ANALYZER_VISION_API_KEY 不是 MiniMax Token Plan Key。",
    };
  }
  try {
    const response = await fetcher(`${apiHost}/v1/coding_plan/vlm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "mm-api-source": "Liming-Zhiyao-Vision-Probe",
      },
      body: JSON.stringify({
        prompt: "只根据图片回答：用一句话描述几何色块和主要颜色。不要推断图片外的信息。",
        image_url: PROBE_IMAGE_DATA_URL,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const responseType = response.headers.get("content-type")?.split(";")[0]?.trim() || "unknown";
    const requestId = response.headers.get("trace-id") || response.headers.get("x-request-id") || response.headers.get("request-id");
    const raw = await response.text();
    let payload: Record<string, unknown> | null = null;
    try { payload = record(JSON.parse(raw)); } catch { payload = null; }
    const baseResponse = record(payload?.base_resp);
    const providerCode = typeof baseResponse?.status_code === "number" ? baseResponse.status_code : null;
    const content = typeof payload?.content === "string" ? payload.content.trim() : "";
    const passed = response.ok && (providerCode === null || providerCode === 0) && content.length >= 10;
    const providerMessage = typeof baseResponse?.status_msg === "string" ? baseResponse.status_msg : "";
    return {
      ...base,
      status: passed ? "passed" : "failed",
      endpointConnected: response.ok,
      imageTestPassed: passed,
      observationCount: passed ? 1 : 0,
      httpStatus: response.status,
      responseType,
      requestId,
      providerCode,
      message: passed
        ? "内置测试图已获得有效图片描述；Worker 可使用官方 MCP understand_image。"
        : safeMessage(providerMessage || (!payload ? "MiniMax 返回了非 JSON 响应。" : `图片预检失败（HTTP ${response.status}）。`)),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      endpointConnected: false,
      imageTestPassed: false,
      observationCount: 0,
      httpStatus: null,
      responseType: "exception",
      requestId: null,
      providerCode: null,
      message: safeMessage(error instanceof Error ? error.message : error),
    };
  }
}
