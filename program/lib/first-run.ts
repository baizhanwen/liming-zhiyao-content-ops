import { env } from "cloudflare:workers";
import { getD1, makeSlug, sha256Hex } from "../db/runtime";
import { createLocalCredential, validateLocalPassword } from "./local-auth";
import { deliveryPlan } from "./delivery-entitlements";

type DeliveryEnv = typeof env & {
  DELIVERY_MODE?: string;
  FIRST_RUN_SETUP_CODE?: string;
  FIRST_RUN_SETUP_CODE_HASH?: string;
};

export type FirstRunStatus = {
  deliveryMode: boolean;
  setupRequired: boolean;
  setupCodeConfigured: boolean;
};

export function isDeliveryMode() {
  return (env as DeliveryEnv).DELIVERY_MODE?.trim() === "1";
}

export function isLoopbackUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function configuredSetupCode() {
  const runtime = env as DeliveryEnv;
  return {
    hash: runtime.FIRST_RUN_SETUP_CODE_HASH?.trim().toLowerCase() ?? "",
    legacyPlaintext: runtime.FIRST_RUN_SETUP_CODE?.trim() ?? "",
  };
}

function hashesEqual(expected: string, supplied: string) {
  if (expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function readFirstRunStatus(): Promise<FirstRunStatus> {
  const deliveryMode = isDeliveryMode();
  if (!deliveryMode) return { deliveryMode: false, setupRequired: false, setupCodeConfigured: false };
  const organization = await getD1().prepare("SELECT 1 AS configured FROM organizations LIMIT 1").first<{ configured: number }>();
  const setupCompleted = await getD1().prepare("SELECT value FROM installation_settings WHERE key = 'setup_completed' LIMIT 1").first<{ value: string }>();
  return {
    deliveryMode,
    setupRequired: !organization && setupCompleted?.value !== "1",
    setupCodeConfigured: Boolean(configuredSetupCode().hash || configuredSetupCode().legacyPlaintext),
  };
}

export async function initializeCommercialInstallation(input: {
  companyName: string;
  administratorName: string;
  email: string;
  password: string;
  setupCode: string;
}) {
  const status = await readFirstRunStatus();
  if (!status.deliveryMode) throw new Error("FIRST_RUN_NOT_AVAILABLE");
  if (!status.setupRequired) throw new Error("FIRST_RUN_ALREADY_COMPLETED");

  const configured = configuredSetupCode();
  if (!configured.hash && !configured.legacyPlaintext) throw new Error("FIRST_RUN_CODE_NOT_CONFIGURED");
  const suppliedHash = await sha256Hex(new TextEncoder().encode(input.setupCode.trim()));
  const expectedHash = configured.hash || await sha256Hex(new TextEncoder().encode(configured.legacyPlaintext));
  if (!/^[0-9a-f]{64}$/u.test(expectedHash) || !hashesEqual(expectedHash, suppliedHash)) {
    throw new Error("FIRST_RUN_CODE_INVALID");
  }

  const companyName = input.companyName.trim();
  const administratorName = input.administratorName.trim();
  const email = input.email.trim().toLowerCase();
  if (companyName.length < 2 || companyName.length > 80) throw new Error("FIRST_RUN_COMPANY_INVALID");
  if (administratorName.length < 2 || administratorName.length > 80) throw new Error("FIRST_RUN_NAME_INVALID");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) throw new Error("FIRST_RUN_EMAIL_INVALID");
  const invalidPassword = validateLocalPassword(input.password);
  if (invalidPassword) throw new Error(`FIRST_RUN_PASSWORD_INVALID:${invalidPassword}`);

  const db = getD1();
  const [existingOrganization, completedSetting] = await Promise.all([
    db.prepare("SELECT 1 AS configured FROM organizations LIMIT 1").first<{ configured: number }>(),
    db.prepare("SELECT value FROM installation_settings WHERE key = 'setup_completed' LIMIT 1").first<{ value: string }>(),
  ]);
  if (existingOrganization || completedSetting?.value === "1") throw new Error("FIRST_RUN_ALREADY_COMPLETED");

  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const authSubject = `local:${crypto.randomUUID()}`;
  const credential = await createLocalCredential(userId, input.password, now);
  const preset = deliveryPlan.quotas;
  try {
    await db.batch([
    // D1 batches are transactional. The unique installation key arbitrates
    // concurrent requests before either one creates users or organizations.
    db.prepare("DELETE FROM installation_settings WHERE key = 'setup_completed' AND value != '1'"),
    db.prepare("INSERT INTO installation_settings (key, value, updated_at) VALUES ('setup_completed', '1', ?)").bind(now),
    db.prepare("INSERT INTO users (id, auth_subject, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
      .bind(userId, authSubject, email, administratorName, now, now),
    db.prepare("INSERT INTO local_credentials (user_id, password_salt, password_hash, iterations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(credential.userId, credential.passwordSalt, credential.passwordHash, credential.iterations, credential.now, credential.now),
    db.prepare("INSERT INTO organizations (id, name, slug, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
      .bind(organizationId, companyName, makeSlug(companyName, organizationId), userId, now, now),
    db.prepare("INSERT INTO organization_members (id, organization_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, userId, userId, userId, now, now),
    db.prepare("INSERT INTO organization_settings (id, organization_id, plan_code, project_quota, member_quota, monthly_analysis_quota, monthly_model_call_quota, storage_quota_bytes, retention_days, failed_job_alert_threshold, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, deliveryPlan.code, preset.projectQuota, preset.memberQuota, preset.monthlyAnalysisQuota, preset.monthlyModelCallQuota, preset.storageQuotaBytes, preset.retentionDays, preset.failedJobAlertThreshold, userId, userId, now, now),
    db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'installation.initialized', 'organization', ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, userId, organizationId, JSON.stringify({ companyName, email }), now),
    ]);
  } catch (error) {
    const completed = await db.prepare("SELECT value FROM installation_settings WHERE key = 'setup_completed'").first<{ value: string }>();
    if (completed?.value === "1") throw new Error("FIRST_RUN_ALREADY_COMPLETED");
    throw error;
  }
  return { organizationId, userId, email, administratorName, companyName };
}
