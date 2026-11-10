export type ConfigurableModelRole = "analysisText" | "contentGeneration" | "visualUnderstanding" | "projectAssistant";

export type PublicModelConfiguration = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  updatedAt: string | null;
  source?: "organization" | "environment";
};

export type ModelConfigurationDraft = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
};

export function modelConfigurationDraft(saved: PublicModelConfiguration): ModelConfigurationDraft {
  return { provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model, apiKey: "", clearApiKey: false };
}

export function modelConfigurationUpdate(draft: ModelConfigurationDraft, saved: PublicModelConfiguration) {
  const provider = draft.provider.trim();
  const baseUrl = draft.baseUrl.trim().replace(/\/+$/, "");
  const model = draft.model.trim();
  const apiKey = draft.apiKey.trim();
  const endpointChanged = provider !== saved.provider.trim() || baseUrl !== saved.baseUrl.trim().replace(/\/+$/, "");
  if (saved.apiKeyConfigured && endpointChanged && !apiKey && !draft.clearApiKey) {
    throw new Error("更换提供方或接口地址时，请填写对应的新密钥，或明确清除当前密钥。");
  }
  return {
    provider, baseUrl, model,
    ...(draft.clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}),
  };
}
