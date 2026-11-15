import { isMiniMaxTokenPlanKey } from "./minimax-vision";

/** Match the analyzer's supported adapters without making a remote probe. */
export function supportsConfiguredVision(runtime: Record<string, string>) {
  const provider = runtime.ANALYZER_VISION_PROVIDER?.trim().toLowerCase() ?? "";
  const model = runtime.ANALYZER_VISION_MODEL?.trim() ?? "";
  const key = runtime.ANALYZER_VISION_API_KEY?.trim() ?? "";
  const endpoint = runtime.ANALYZER_VISION_BASE_URL?.trim() ?? "";
  if (provider === "minimax" && model === "MiniMax-M3.1-Flash" && key) {
    try {
      if (["api.minimax.cn", "api.minimaxi.com", "api.minimax.io"].includes(new URL(endpoint).hostname)) return true;
    } catch { /* Fall through to the adapter checks below. */ }
  }
  const tokenPlanProviders = ["minimax", "minimax-token-plan", "minimax_token_plan"];
  if (isMiniMaxTokenPlanKey(key)) return !provider || tokenPlanProviders.includes(provider);
  if (tokenPlanProviders.includes(provider) || !provider || !model || !key || !endpoint) return false;
  const compatibleProviders = ["openai", "openai-compatible", "glm", "zhipu", "qwen", "dashscope"];
  const markers = ["gpt-4o", "gpt-4.1", "vision", "glm-4v", "glm-4.5v", "glm-4.6v", "qwen-vl", "qwen2.5-vl", "qwen3-vl"];
  return compatibleProviders.includes(provider) && markers.some(marker => model.toLowerCase().includes(marker));
}
