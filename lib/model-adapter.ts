import { env } from "cloudflare:workers";

type ModelProfile = "fast" | "standard" | "advanced";
type ModelRuntimeEnv = typeof env & {
  CONTENT_MODEL_API_KEY?: string;
  CONTENT_MODEL_BASE_URL?: string;
  CONTENT_MODEL_NAME?: string;
  CONTENT_MODEL_PROVIDER?: string;
  ANALYZER_LLM_API_KEY?: string;
  ANALYZER_LLM_BASE_URL?: string;
  ANALYZER_LLM_MODEL?: string;
  ANALYZER_LLM_PROVIDER?: string;
};

export class ModelConfigurationError extends Error {}
export class ModelRequestError extends Error {
  constructor(message: string, readonly code = "MODEL_REQUEST_FAILED") { super(message); }
}

export type ModelInvocation = {
  provider: string;
  model: string;
  profile: ModelProfile;
  content: string;
  raw: unknown;
  latencyMs: number;
};

export function readContentModelConfig(profile: ModelProfile) {
  const runtime = env as ModelRuntimeEnv;
  const apiKey = (runtime.CONTENT_MODEL_API_KEY || runtime.ANALYZER_LLM_API_KEY)?.trim();
  const baseUrl = (runtime.CONTENT_MODEL_BASE_URL || runtime.ANALYZER_LLM_BASE_URL)?.trim().replace(/\/+$/, "");
  const model = (runtime.CONTENT_MODEL_NAME || runtime.ANALYZER_LLM_MODEL)?.trim();
  const provider = (runtime.CONTENT_MODEL_PROVIDER || runtime.ANALYZER_LLM_PROVIDER)?.trim() || "openai-compatible";
  if (!apiKey || !baseUrl || !model) throw new ModelConfigurationError("模型尚未配置。请在本地配置中填写模型地址、名称和密钥。");
  return { apiKey, baseUrl, model, provider, profile };
}

function responseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.trim() ? content : null;
}

export async function invokeContentModel(input: { system: string; user: string; profile: ModelProfile }): Promise<ModelInvocation> {
  const config = readContentModelConfig(input.profile);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
        temperature: input.profile === "advanced" ? 0.55 : 0.35,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    const raw = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = raw && typeof raw === "object" && "error" in raw ? JSON.stringify((raw as { error: unknown }).error).slice(0, 500) : `HTTP ${response.status}`;
      throw new ModelRequestError(`内容模型调用失败：${detail}`, `MODEL_HTTP_${response.status}`);
    }
    const content = responseText(raw);
    if (!content) throw new ModelRequestError("内容模型没有返回可解析的文本。", "MODEL_EMPTY_RESPONSE");
    return { provider: config.provider, model: config.model, profile: config.profile, content, raw, latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new ModelRequestError("内容模型调用超时。", "MODEL_TIMEOUT");
    throw new ModelRequestError(error instanceof Error ? error.message : "内容模型调用失败。");
  } finally {
    clearTimeout(timeout);
  }
}
