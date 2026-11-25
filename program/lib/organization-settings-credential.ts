import { env } from "cloudflare:workers";

type CredentialEndpoint = { provider: string; baseUrl: string };

export class OrganizationSettingsError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

async function encryptionKey() {
  const value = (env as { MODEL_SETTINGS_ENCRYPTION_KEY?: string }).MODEL_SETTINGS_ENCRYPTION_KEY || "";
  if (!/^[a-f\d]{64}$/i.test(value)) throw new OrganizationSettingsError("MODEL_SETTINGS_KEY_REQUIRED", "本机模型配置加密尚未初始化，请重新启动项目。", 503);
  const bytes = Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function additionalData(organizationId: string, role: string, config: CredentialEndpoint) {
  return new TextEncoder().encode(JSON.stringify([organizationId, role, config.provider, config.baseUrl]));
}

export async function sealCredential(value: string, organizationId: string, role: string, config: CredentialEndpoint) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(organizationId, role, config) }, await encryptionKey(), new TextEncoder().encode(value)));
  return `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...encrypted))}`;
}

export async function unsealCredential(value: string | null, organizationId: string, role: string, config: CredentialEndpoint) {
  if (!value) return "";
  try {
    const [version, nonce, body] = value.split(".");
    if (version !== "v1" || !nonce || !body) throw new Error("invalid encrypted value");
    const iv = Uint8Array.from(atob(nonce), (char) => char.charCodeAt(0));
    const data = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(organizationId, role, config) }, await encryptionKey(), data));
  } catch {
    throw new OrganizationSettingsError("MODEL_SETTINGS_DECRYPT_FAILED", "本项目的模型凭据无法读取，请在设置页重新填写密钥。", 503);
  }
}
