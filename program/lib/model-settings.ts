import { env } from "cloudflare:workers";
import { getD1 } from "../db/runtime";
import { isMiniMaxFlashVisionConfiguration, isMiniMaxTokenPlanKey, probeMiniMaxTokenPlanVision, visionConfigurationFingerprint } from "./minimax-vision";

export const modelRoles = ["analysisText", "contentGeneration", "visualUnderstanding", "projectAssistant"] as const;
export type ModelRole = typeof modelRoles[number];
export const modelRoleKeys: Record<ModelRole, readonly [string, string, string, string]> = {
  analysisText: ["ANALYZER_LLM_PROVIDER", "ANALYZER_LLM_BASE_URL", "ANALYZER_LLM_MODEL", "ANALYZER_LLM_API_KEY"],
  contentGeneration: ["CONTENT_MODEL_PROVIDER", "CONTENT_MODEL_BASE_URL", "CONTENT_MODEL_NAME", "CONTENT_MODEL_API_KEY"],
  visualUnderstanding: ["ANALYZER_VISION_PROVIDER", "ANALYZER_VISION_BASE_URL", "ANALYZER_VISION_MODEL", "ANALYZER_VISION_API_KEY"],
  projectAssistant: ["PROJECT_ASSISTANT_MODEL_PROVIDER", "PROJECT_ASSISTANT_MODEL_BASE_URL", "PROJECT_ASSISTANT_MODEL_NAME", "PROJECT_ASSISTANT_MODEL_API_KEY"],
};
type StoredRole = { provider: string; baseUrl: string; model: string; key: string | null };
type StoredSettings = Partial<Record<ModelRole, StoredRole>>;
type Row = { version: number; settings_json: string; updated_at: string };
export type ModelRolePatch = { provider: string; baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean };

export class ModelSettingsError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

function environmentRuntime(): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function validateModelEndpoint(value: string) {
  if (!value) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new ModelSettingsError("INVALID_MODEL_ENDPOINT", "请填写有效的 HTTPS 模型接口地址。"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) {
    throw new ModelSettingsError("INVALID_MODEL_ENDPOINT", "模型接口须使用公网 HTTPS 域名，不能包含账号、查询参数或本机地址。");
  }
  return url.toString().replace(/\/+$/, "");
}

async function encryptionKey() {
  const value = environmentRuntime().MODEL_SETTINGS_ENCRYPTION_KEY || "";
  if (!/^[a-f\d]{64}$/i.test(value)) throw new ModelSettingsError("MODEL_SETTINGS_KEY_REQUIRED", "本机模型配置加密尚未初始化，请重新启动项目。", 503);
  const bytes = Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function additionalData(organizationId: string, role: ModelRole, config: Pick<StoredRole, "provider" | "baseUrl">) {
  return new TextEncoder().encode(JSON.stringify([organizationId, role, config.provider, config.baseUrl]));
}

async function seal(value: string, organizationId: string, role: ModelRole, config: StoredRole) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(organizationId, role, config) }, await encryptionKey(), new TextEncoder().encode(value)));
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...encrypted))}`;
}

async function unseal(value: string | null, organizationId: string, role: ModelRole, config: StoredRole) {
  if (!value) return "";
  try {
    const [version, nonce, body] = value.split(".");
    if (version !== "v1" || !nonce || !body) throw new Error("invalid encrypted value");
    const iv = Uint8Array.from(atob(nonce), (char) => char.charCodeAt(0));
    const data = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(organizationId, role, config) }, await encryptionKey(), data));
  } catch {
    throw new ModelSettingsError("MODEL_SETTINGS_DECRYPT_FAILED", "本项目的模型凭据无法读取，请在设置页重新填写密钥。", 503);
  }
}

async function storedSettings(organizationId: string) {
  const row = await getD1().prepare("SELECT version, settings_json, updated_at FROM organization_model_settings WHERE organization_id = ?").bind(organizationId).first<Row>();
  return { row, settings: row ? JSON.parse(row.settings_json) as StoredSettings : {} };
}

export async function readEffectiveModelRuntime(organizationId: string): Promise<Record<string, string>> {
  const runtime = environmentRuntime();
  const { settings } = await storedSettings(organizationId);
  for (const role of modelRoles) {
    const config = settings[role];
    if (!config) continue;
    const keys = modelRoleKeys[role];
    runtime[keys[0]] = config.provider;
    runtime[keys[1]] = config.baseUrl;
    runtime[keys[2]] = config.model;
    runtime[keys[3]] = await unseal(config.key, organizationId, role, config);
    if (role === "contentGeneration") runtime.CONTENT_MODEL_CONFIGURED_IN_UI = "1";
  }
  return runtime;
}

export async function readModelSettings(organizationId: string) {
  const { row, settings } = await storedSettings(organizationId);
  const runtime = await readEffectiveModelRuntime(organizationId);
  const roles = Object.fromEntries(modelRoles.map((role) => {
    const keys = modelRoleKeys[role];
    const fallback = role === "contentGeneration" && !settings[role] ? modelRoleKeys.analysisText : null;
    return [role, {
      provider: runtime[keys[0]] || (fallback && runtime[fallback[0]]) || "",
      baseUrl: runtime[keys[1]] || (fallback && runtime[fallback[1]]) || "",
      model: runtime[keys[2]] || (fallback && runtime[fallback[2]]) || "",
      apiKeyConfigured: Boolean(runtime[keys[3]] || (fallback && runtime[fallback[3]])),
      source: settings[role] ? "organization" : "environment", updatedAt: row?.updated_at || null,
    }];
  }));
  return { roles, version: row?.version || 0 };
}

export async function saveModelSettings(organizationId: string, userId: string, patches: Partial<Record<ModelRole, ModelRolePatch>>, expectedVersion?: number) {
  const { row, settings } = await storedSettings(organizationId);
  const version = row?.version || 0;
  if (expectedVersion !== undefined && expectedVersion !== version) throw new ModelSettingsError("MODEL_SETTINGS_CONFLICT", "配置已被其他操作更新，请刷新后重试。", 409);
  const runtime = await readEffectiveModelRuntime(organizationId);
  for (const role of modelRoles) {
    const patch = patches[role];
    if (!patch) continue;
    const keys = modelRoleKeys[role];
    const provider = patch.provider.trim();
    const baseUrl = validateModelEndpoint(patch.baseUrl.trim());
    const model = patch.model.trim();
    const previous = settings[role];
    const oldKey = runtime[keys[3]] || (role === "contentGeneration" && !previous ? runtime.ANALYZER_LLM_API_KEY : "") || "";
    const oldProvider = runtime[keys[0]] || (role === "contentGeneration" && !previous ? runtime.ANALYZER_LLM_PROVIDER : "") || "";
    const oldBase = runtime[keys[1]] || (role === "contentGeneration" && !previous ? runtime.ANALYZER_LLM_BASE_URL : "") || "";
    const newKey = patch.apiKey?.trim() || "";
    if (oldKey && !newKey && !patch.clearApiKey && (provider !== oldProvider || baseUrl !== oldBase.replace(/\/+$/, ""))) {
      throw new ModelSettingsError("NEW_MODEL_KEY_REQUIRED", "更换模型提供方或接口地址时，请同时填写新密钥，或明确清除旧密钥。");
    }
    const key = patch.clearApiKey ? "" : newKey || oldKey;
    if (key && (!provider || !baseUrl || !model)) throw new ModelSettingsError("INCOMPLETE_MODEL_CONFIG", "保存密钥前请填写提供方、接口地址和模型名称。");
    const config: StoredRole = { provider, baseUrl, model, key: null };
    if (key) config.key = await seal(key, organizationId, role, config);
    settings[role] = config;
  }
  const db = getD1();
  const now = new Date().toISOString();
  const mutation = row
    ? db.prepare("UPDATE organization_model_settings SET settings_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE organization_id = ? AND version = ?").bind(JSON.stringify(settings), userId, now, organizationId, version)
    : db.prepare("INSERT OR IGNORE INTO organization_model_settings (organization_id, version, settings_json, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)").bind(organizationId, JSON.stringify(settings), userId, now);
  const changed = await db.batch([
    mutation,
    db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, NULL, ?, 'model.settings_updated', 'model_settings', ?, ?, ? WHERE changes() = 1")
      .bind(crypto.randomUUID(), organizationId, userId, organizationId, JSON.stringify({ roles: Object.keys(patches), version: version + 1 }), now),
  ]);
  if (!changed[0].meta.changes) throw new ModelSettingsError("MODEL_SETTINGS_CONFLICT", "配置已更新，请刷新后重试。", 409);
  return readModelSettings(organizationId);
}

export async function probeSavedModelConfiguration(organizationId: string, role: ModelRole) {
  const runtime = await readEffectiveModelRuntime(organizationId);
  const keys = modelRoleKeys[role];
  const provider = runtime[keys[0]] || "";
  const model = runtime[keys[2]] || "";
  const key = runtime[keys[3]] || "";
  const checkedAt = new Date().toISOString();
  const fingerprint = role === "visualUnderstanding" ? visionConfigurationFingerprint(runtime) : undefined;
  if (!key || !model || !runtime[keys[1]]) return { status: "failed" as const, message: "请先保存完整的模型地址、名称和密钥。", checkedAt, fingerprint };
  if (role === "visualUnderstanding" && !isMiniMaxFlashVisionConfiguration(runtime) && isMiniMaxTokenPlanKey(key)) {
    return probeMiniMaxTokenPlanVision(runtime);
  }
  const baseUrl = validateModelEndpoint(runtime[keys[1]]);
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABLUlEQVR4nO3TMREAMAwDsST8ObcwtLwIePjzvol0dD0F0HoAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAJgBcAKgBUAKwBWAKwAWAGwAmAFwAqAFQArAFYArABYAbACYAXACoAVACsAVgCsAFgBsAKM9QHP4QH/xCXf5QAAAABJRU5ErkJggg==";
  const content = role === "visualUnderstanding" ? [{ type: "text", text: "这是一张测试图。简短说明主色即可。" }, { type: "image_url", image_url: { url: image } }] : "这是连接测试。只回复 OK。";
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false,
        ...(provider.toLowerCase() === "minimax" && model === "MiniMax-M3.1-Flash" ? { reasoning_effort: "low", max_completion_tokens: 16384 } : { max_tokens: 512 }),
      }),
    });
    if (!response.ok) return { status: "failed" as const, message: `模型服务未接受测试请求（HTTP ${response.status}），请检查密钥、接口和模型权限。`, checkedAt, httpStatus: response.status, fingerprint };
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
    const message = body.choices?.[0]?.message;
    const valid = typeof message?.content === "string" && message.content.trim().length > 0;
    return { status: valid ? "passed" as const : "failed" as const, message: valid ? "模型已返回有效响应，当前配置可用。" : "模型接口已响应，但没有返回有效正文，请检查模型参数与输出预算。", checkedAt, httpStatus: response.status, fingerprint };
  } catch (error) {
    const diagnostic = String(error instanceof Error ? `${error.name}: ${error.message}` : "connection failed").replaceAll(key, "[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 400);
    console.warn("model.connection_test_failed", diagnostic);
    return { status: "failed" as const, message: "模型连接测试失败或超时，请检查本机网络和接口地址。", checkedAt, fingerprint };
  }
}
