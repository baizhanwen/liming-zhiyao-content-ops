import { env } from "cloudflare:workers";
import { getD1 } from "../db/runtime";
import { OrganizationSettingsError, sealCredential, unsealCredential } from "./organization-settings-credential";

type SettingsRow = { encrypted_key: string | null; version: number; updated_at: string };
type TikHubKeyPatch = { apiKey?: string; clearApiKey?: boolean };
type KeySource = "organization" | "environment" | "none";
const endpoint = { provider: "tikhub", baseUrl: "https://api.tikhub.io" };
const activeAdministrator = `SELECT 1 FROM organization_members m
  JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active' AND m.role = 'admin'`;

async function requireCurrentAdmin(organizationId: string, userId: string) {
  if (!await getD1().prepare(activeAdministrator).bind(organizationId, userId).first()) {
    throw new OrganizationSettingsError("ADMIN_REQUIRED", "只有当前公司的管理员可以修改 TikHub 配置。", 403);
  }
}

function environmentKey() {
  return (env as { TIKHUB_API_KEY?: string }).TIKHUB_API_KEY?.trim() || "";
}

function storedSettings(organizationId: string) {
  return getD1().prepare("SELECT encrypted_key, version, updated_at FROM organization_tikhub_settings WHERE organization_id = ?")
    .bind(organizationId).first<SettingsRow>();
}

function publicSettings(row: SettingsRow | null) {
  const source: KeySource = row?.encrypted_key ? "organization" : environmentKey() ? "environment" : "none";
  return { source, apiKeyConfigured: source !== "none", version: row?.version ?? 0, updatedAt: row?.updated_at ?? null };
}

export async function readTikHubSettings(organizationId: string) {
  return publicSettings(await storedSettings(organizationId));
}

export async function readEffectiveTikHubKey(organizationId: string) {
  const row = await storedSettings(organizationId);
  if (!row?.encrypted_key) return environmentKey();
  try {
    return await unsealCredential(row.encrypted_key, organizationId, "tikhub", endpoint);
  } catch {
    throw new OrganizationSettingsError("TIKHUB_KEY_UNREADABLE", "已保存的 TikHub 密钥无法解密，请在系统设置中重新填写。", 503);
  }
}

export async function saveTikHubSettings(organizationId: string, userId: string, patch: TikHubKeyPatch, expectedVersion: number) {
  const row = await storedSettings(organizationId);
  const version = row?.version ?? 0;
  const conflict = () => new OrganizationSettingsError("TIKHUB_SETTINGS_CONFLICT", "TikHub 配置已更新，请刷新后重试。", 409);
  if (expectedVersion !== version) throw conflict();
  const key = patch.apiKey?.trim() ?? "";
  if ((patch.clearApiKey && key) || (key && !/^[!-~]{1,16000}$/.test(key))) {
    throw new OrganizationSettingsError("INVALID_TIKHUB_KEY", "请填写有效的 TikHub API Key，或单独选择恢复服务端配置。");
  }
  if (!key && (!patch.clearApiKey || !row?.encrypted_key)) {
    await requireCurrentAdmin(organizationId, userId);
    return publicSettings(row);
  }
  const encrypted = key ? await sealCredential(key, organizationId, "tikhub", endpoint) : null;
  const db = getD1();
  const now = new Date().toISOString();
  const mutation = row
    ? db.prepare(`UPDATE organization_tikhub_settings SET encrypted_key = ?, version = version + 1, updated_by = ?, updated_at = ?
        WHERE organization_id = ? AND version = ? AND EXISTS (${activeAdministrator})`)
      .bind(encrypted, userId, now, organizationId, version, organizationId, userId)
    : db.prepare(`INSERT OR IGNORE INTO organization_tikhub_settings (organization_id, version, encrypted_key, updated_by, updated_at)
        SELECT ?, 1, ?, ?, ? WHERE EXISTS (${activeAdministrator})`).bind(organizationId, encrypted, userId, now, organizationId, userId);
  const [changed] = await db.batch([
    mutation,
    db.prepare(`INSERT INTO audit_logs (id, organization_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?, ?, ?, 'tikhub.settings_updated', 'tikhub_settings', ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), organizationId, userId, organizationId, JSON.stringify({ version: version + 1 }), now),
  ]);
  if (!changed.meta.changes) {
    await requireCurrentAdmin(organizationId, userId);
    throw conflict();
  }
  return publicSettings({ encrypted_key: encrypted, version: version + 1, updated_at: now });
}
