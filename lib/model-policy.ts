export function parseModelAllowList(value: string | undefined) {
  return (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function modelPolicyError(input: {
  provider: string;
  model: string;
  allowedProviders?: string;
  allowedModels?: string;
}) {
  const providers = parseModelAllowList(input.allowedProviders);
  const models = parseModelAllowList(input.allowedModels);
  if (providers.length && !providers.includes(input.provider.trim().toLowerCase())) {
    return "模型提供方 " + input.provider + " 不在允许列表中。";
  }
  if (models.length && !models.includes(input.model.trim().toLowerCase())) {
    return "模型 " + input.model + " 不在允许列表中。";
  }
  return null;
}