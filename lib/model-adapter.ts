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

function contentPartText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (Array.isArray(value)) {
    const joined = value.map((part) => contentPartText(part)).filter((part): part is string => Boolean(part)).join("");
    return joined.trim() ? joined : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return contentPartText(record.text) || contentPartText(record.content) || contentPartText(record.value);
}

export function extractModelResponseText(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const direct = contentPartText(root.output_text) || contentPartText(root.content);
  if (direct) return direct;
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : null;
  const messageText = message ? contentPartText(message.content) : null;
  if (messageText) return messageText;
  const legacyText = contentPartText(choice.text);
  if (legacyText) return legacyText;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) return null;
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const fn = (toolCall as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const argumentsText = contentPartText((fn as Record<string, unknown>).arguments);
    if (argumentsText) return argumentsText;
  }
  return null;
}

export async function invokeContentModel(input: { system: string; user: string; profile: ModelProfile; nativeJson?: boolean }): Promise<ModelInvocation> {
  const config = readContentModelConfig(input.profile);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  try {
    const isDeepSeek = config.provider.toLowerCase().includes("deepseek") || config.baseUrl.toLowerCase().includes("deepseek");
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
      temperature: input.profile === "advanced" ? 0.55 : 0.35,
      max_tokens: input.profile === "fast" ? 4_000 : input.profile === "advanced" ? 8_000 : 6_000,
    };
    if (input.nativeJson !== false) requestBody.response_format = { type: "json_object" };
    if (isDeepSeek) requestBody.thinking = { type: "disabled" };
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = raw && typeof raw === "object" && "error" in raw ? JSON.stringify((raw as { error: unknown }).error).slice(0, 500) : `HTTP ${response.status}`;
      throw new ModelRequestError(`内容模型调用失败：${detail}`, `MODEL_HTTP_${response.status}`);
    }
    const content = extractModelResponseText(raw);
    if (!content) {
      const finishReason = raw && typeof raw === "object" && Array.isArray((raw as { choices?: unknown }).choices) ? ((raw as { choices: Array<{ finish_reason?: unknown }> }).choices[0]?.finish_reason) : null;
      const suffix = finishReason === "length" ? "模型输出达到长度上限，请切换标准或高级档位后重试。" : "DeepSeek 的原生 JSON 模式偶尔会返回空内容，系统将切换兼容模式重试。";
      throw new ModelRequestError(`内容模型没有返回可解析的文本。${suffix}`, finishReason === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_EMPTY_RESPONSE");
    }
    return { provider: config.provider, model: config.model, profile: config.profile, content, raw, latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ModelRequestError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new ModelRequestError("内容模型调用超时。", "MODEL_TIMEOUT");
    throw new ModelRequestError(error instanceof Error ? error.message : "内容模型调用失败。");
  } finally {
    clearTimeout(timeout);
  }
}
