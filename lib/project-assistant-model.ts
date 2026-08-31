import { env } from "cloudflare:workers";

type ProjectAssistantRuntimeEnv = typeof env & {
  PROJECT_ASSISTANT_MODEL_PROVIDER?: string;
  PROJECT_ASSISTANT_MODEL_BASE_URL?: string;
  PROJECT_ASSISTANT_MODEL_NAME?: string;
  PROJECT_ASSISTANT_MODEL_API_KEY?: string;
};

export type ProjectAssistantModelConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type ProjectAssistantInvocation = {
  provider: string;
  model: string;
  content: string;
  latencyMs: number;
  raw: unknown;
};

export class ProjectAssistantConfigurationError extends Error {
  readonly code = "PROJECT_ASSISTANT_NOT_CONFIGURED";
}

export class ProjectAssistantRequestError extends Error {
  constructor(message: string, readonly code = "PROJECT_ASSISTANT_REQUEST_FAILED") {
    super(message);
  }
}

const variableNames = [
  "PROJECT_ASSISTANT_MODEL_PROVIDER",
  "PROJECT_ASSISTANT_MODEL_BASE_URL",
  "PROJECT_ASSISTANT_MODEL_NAME",
  "PROJECT_ASSISTANT_MODEL_API_KEY",
] as const;

function runtimeValue(runtime: Partial<ProjectAssistantRuntimeEnv>, name: typeof variableNames[number]) {
  const value = runtime[name];
  return typeof value === "string" ? value.trim() : "";
}

export function readProjectAssistantModelConfig(
  runtime: Partial<ProjectAssistantRuntimeEnv> = env as ProjectAssistantRuntimeEnv,
): ProjectAssistantModelConfig {
  const provider = runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_PROVIDER");
  const baseUrl = runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_BASE_URL").replace(/\/+$/, "");
  const model = runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_NAME");
  const apiKey = runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_API_KEY");
  const missing = variableNames.filter((name) => !runtimeValue(runtime, name));
  if (missing.length) {
    throw new ProjectAssistantConfigurationError(
      "独立项目助理模型尚未配置完整。缺少：" + missing.join("、") + "。系统不会借用内容生成或视频分析的模型密钥。",
    );
  }
  return { provider, baseUrl, model, apiKey };
}

export function projectAssistantConfigurationStatus(
  runtime: Partial<ProjectAssistantRuntimeEnv> = env as ProjectAssistantRuntimeEnv,
) {
  const missing = variableNames.filter((name) => !runtimeValue(runtime, name));
  return {
    configured: missing.length === 0,
    missing,
    provider: runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_PROVIDER") || null,
    baseUrl: runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_BASE_URL").replace(/\/+$/, "") || null,
    model: runtimeValue(runtime, "PROJECT_ASSISTANT_MODEL_NAME") || null,
    isolation: "independent" as const,
    implicitFallback: false as const,
  };
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map(contentText).filter((part): part is string => Boolean(part)).join("");
    return joined.trim() || null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return contentText(row.text) || contentText(row.content) || contentText(row.value);
}

export function extractProjectAssistantResponseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const direct = contentText(root.output_text) || contentText(root.content);
  if (direct) return direct;
  if (!Array.isArray(root.choices) || !root.choices[0] || typeof root.choices[0] !== "object") return null;
  const choice = root.choices[0] as Record<string, unknown>;
  const message = choice.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : null;
  return (message ? contentText(message.content) : null) || contentText(choice.text);
}

function endpoint(baseUrl: string) {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : baseUrl + "/chat/completions";
}

function safeProviderDetail(raw: unknown, status: number) {
  if (!raw || typeof raw !== "object") return "HTTP " + status;
  const root = raw as Record<string, unknown>;
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : null;
  const message = contentText(error?.message) || contentText(root.message);
  return message ? message.slice(0, 500) : "HTTP " + status;
}

export async function invokeProjectAssistantModel(
  input: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  },
  options?: {
    config?: ProjectAssistantModelConfig;
    fetchImpl?: typeof fetch;
  },
): Promise<ProjectAssistantInvocation> {
  const config = options?.config ?? readProjectAssistantModelConfig();
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5_000, Math.min(120_000, input.timeoutMs ?? 75_000)));
  const started = Date.now();
  try {
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: Math.max(0, Math.min(1, input.temperature ?? 0.35)),
      max_tokens: Math.max(64, Math.min(16_000, input.maxTokens ?? 8_000)),
      response_format: { type: "json_object" },
    };
    if (config.provider.toLowerCase().includes("deepseek") || config.baseUrl.toLowerCase().includes("deepseek")) {
      requestBody.thinking = { type: "disabled" };
    }
    const response = await fetchImpl(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + config.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      throw new ProjectAssistantRequestError(
        "独立项目助理模型调用失败：" + safeProviderDetail(raw, response.status),
        "PROJECT_ASSISTANT_HTTP_" + response.status,
      );
    }
    const content = extractProjectAssistantResponseText(raw);
    if (!content) {
      throw new ProjectAssistantRequestError(
        "独立项目助理模型没有返回可解析的文本。",
        "PROJECT_ASSISTANT_EMPTY_RESPONSE",
      );
    }
    return {
      provider: config.provider,
      model: config.model,
      content,
      latencyMs: Date.now() - started,
      raw,
    };
  } catch (error) {
    if (error instanceof ProjectAssistantRequestError || error instanceof ProjectAssistantConfigurationError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProjectAssistantRequestError("独立项目助理模型调用超时。", "PROJECT_ASSISTANT_TIMEOUT");
    }
    throw new ProjectAssistantRequestError(error instanceof Error ? error.message : "独立项目助理模型调用失败。");
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeProjectAssistantModel() {
  const result = await invokeProjectAssistantModel({
    system: "你是连接健康检查。只返回 JSON 对象。",
    user: '请返回 {"ok":true}。',
    maxTokens: 80,
    temperature: 0,
    timeoutMs: 20_000,
  });
  return { ok: true as const, provider: result.provider, model: result.model, latencyMs: result.latencyMs };
}
