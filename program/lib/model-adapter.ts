import { extractResponseText } from "./model-response.ts";
import { env } from "cloudflare:workers";
import { modelPolicyError } from "./model-policy.ts";
import { readEffectiveModelRuntime } from "./model-settings.ts";

export type ModelProfile = "max";
type ModelRuntimeEnv = typeof env & {
  CONTENT_MODEL_CONFIGURED_IN_UI?: string;
  CONTENT_MODEL_API_KEY?: string;
  CONTENT_MODEL_BASE_URL?: string;
  CONTENT_MODEL_NAME?: string;
  CONTENT_MODEL_PROVIDER?: string;
  ANALYZER_LLM_API_KEY?: string;
  ANALYZER_LLM_BASE_URL?: string;
  ANALYZER_LLM_MODEL?: string;
  ANALYZER_LLM_PROVIDER?: string;
  CONTENT_MODEL_ALLOWED_PROVIDERS?: string;
  CONTENT_MODEL_ALLOWED_MODELS?: string;
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

export function readContentModelConfig(profile: ModelProfile, runtime: Partial<ModelRuntimeEnv> = env as ModelRuntimeEnv) {
  const dedicated = runtime.CONTENT_MODEL_CONFIGURED_IN_UI === "1";
  const apiKey = (dedicated ? runtime.CONTENT_MODEL_API_KEY : runtime.CONTENT_MODEL_API_KEY || runtime.ANALYZER_LLM_API_KEY)?.trim();
  const baseUrl = (dedicated ? runtime.CONTENT_MODEL_BASE_URL : runtime.CONTENT_MODEL_BASE_URL || runtime.ANALYZER_LLM_BASE_URL)?.trim().replace(/\/+$/, "");
  const model = (dedicated ? runtime.CONTENT_MODEL_NAME : runtime.CONTENT_MODEL_NAME || runtime.ANALYZER_LLM_MODEL)?.trim();
  const provider = (dedicated ? runtime.CONTENT_MODEL_PROVIDER : runtime.CONTENT_MODEL_PROVIDER || runtime.ANALYZER_LLM_PROVIDER)?.trim() || "openai-compatible";
  if (!apiKey || !baseUrl || !model) throw new ModelConfigurationError("模型尚未配置。请在系统设置中填写模型地址、名称和密钥。");
  const policyError = modelPolicyError({ provider, model, allowedProviders: runtime.CONTENT_MODEL_ALLOWED_PROVIDERS, allowedModels: runtime.CONTENT_MODEL_ALLOWED_MODELS });
  if (policyError) throw new ModelConfigurationError(policyError);
  return { apiKey, baseUrl, model, provider, profile };
}

export function extractModelResponseText(payload: unknown) {
  return extractResponseText(payload, { toolArguments: true });
}

export async function invokeContentModel(input: { organizationId?: string; system: string; user: string; profile: ModelProfile; nativeJson?: boolean; temperature?: number; maxTokens?: number }, options?: { config?: ReturnType<typeof readContentModelConfig> }): Promise<ModelInvocation> {
  const runtime = !options?.config && input.organizationId ? await readEffectiveModelRuntime(input.organizationId) : undefined;
  const config = options?.config ?? readContentModelConfig(input.profile, runtime ?? env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  try {
    const isDeepSeek = config.provider.toLowerCase().includes("deepseek") || config.baseUrl.toLowerCase().includes("deepseek");
    const isMiniMaxFlash = config.provider.toLowerCase() === "minimax" && config.model.toLowerCase() === "minimax-m3.1-flash";
    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
      temperature: Math.max(0, Math.min(1, input.temperature ?? 0.55)),
      max_tokens: Math.max(600, Math.min(12_000, Math.trunc(input.maxTokens ?? 12_000))),
    };
    if (input.nativeJson !== false && !isMiniMaxFlash) requestBody.response_format = { type: "json_object" };
    if (isMiniMaxFlash) {
      // Match the source lmzy adapter: Flash always reasons, and its completion
      // budget includes reasoning tokens as well as the JSON response.
      requestBody.reasoning_effort = "low";
      requestBody.max_completion_tokens = 16_384;
      delete requestBody.max_tokens;
    }
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
    const finishReason = raw && typeof raw === "object" && Array.isArray((raw as { choices?: unknown }).choices) ? ((raw as { choices: Array<{ finish_reason?: unknown }> }).choices[0]?.finish_reason) : null;
    const content = extractModelResponseText(raw);
    if (finishReason === "length") {
      throw new ModelRequestError("内容模型输出达到长度上限，返回的 JSON 不完整。系统将切换兼容模式重试。", "MODEL_OUTPUT_TRUNCATED");
    }
    if (!content) {
      throw new ModelRequestError("内容模型没有返回可解析的文本。DeepSeek 的原生 JSON 模式偶尔会返回空内容，系统将切换兼容模式重试。", "MODEL_EMPTY_RESPONSE");
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
