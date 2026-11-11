import { getD1 } from "../db/runtime";
import { deliveryPlan } from "./delivery-entitlements";

export type PlanCode = "starter" | "team" | "scale";
export type OrganizationCapacity = {
  plan_code: PlanCode;
  project_quota: number;
  member_quota: number;
  monthly_analysis_quota: number;
  monthly_model_call_quota: number;
  storage_quota_bytes: number;
  retention_days: number;
  failed_job_alert_threshold: number;
};

export async function ensureOrganizationSettings(organizationId: string, actorUserId: string) {
  const preset = deliveryPlan.quotas;
  const now = new Date().toISOString();
  await getD1().prepare(`
    INSERT OR IGNORE INTO organization_settings
      (id, organization_id, plan_code, project_quota, member_quota, monthly_analysis_quota, monthly_model_call_quota, storage_quota_bytes, retention_days, failed_job_alert_threshold, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), organizationId, deliveryPlan.code, preset.projectQuota, preset.memberQuota, preset.monthlyAnalysisQuota, preset.monthlyModelCallQuota, preset.storageQuotaBytes, preset.retentionDays, preset.failedJobAlertThreshold, actorUserId, actorUserId, now, now).run();
}

export async function getOrganizationCapacity(organizationId: string, actorUserId: string): Promise<OrganizationCapacity> {
  await ensureOrganizationSettings(organizationId, actorUserId);
  if (deliveryPlan.deliveryMode) {
    const preset = deliveryPlan.quotas;
    // The full edition supplies effective capacity without rewriting historical
    // settings when an older installation is opened after an upgrade.
    return {
      plan_code: deliveryPlan.code,
      project_quota: preset.projectQuota,
      member_quota: preset.memberQuota,
      monthly_analysis_quota: preset.monthlyAnalysisQuota,
      monthly_model_call_quota: preset.monthlyModelCallQuota,
      storage_quota_bytes: preset.storageQuotaBytes,
      retention_days: preset.retentionDays,
      failed_job_alert_threshold: preset.failedJobAlertThreshold,
    };
  }
  const row = await getD1().prepare(`
    SELECT plan_code, project_quota, member_quota, monthly_analysis_quota, monthly_model_call_quota, storage_quota_bytes, retention_days, failed_job_alert_threshold
    FROM organization_settings WHERE organization_id = ?
  `).bind(organizationId).first<OrganizationCapacity>();
  if (!row) throw new Error("Organization capacity is unavailable");
  return row;
}

export function currentMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function readOrganizationUsage(organizationId: string) {
  const db = getD1();
  const monthStart = currentMonthStart();
  const monthDate = new Date(monthStart);
  const nextMonthStart = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1)).toISOString();
  const [projects, members, analyses, modelCalls, storage] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS value FROM projects WHERE organization_id = ? AND deleted_at IS NULL AND status != 'archived'").bind(organizationId).first<{ value: number }>(),
    db.prepare("SELECT (SELECT COUNT(*) FROM organization_members WHERE organization_id = ? AND status = 'active') + (SELECT COUNT(*) FROM invitations WHERE organization_id = ? AND status = 'pending' AND julianday(expires_at) > julianday('now')) AS value").bind(organizationId, organizationId).first<{ value: number }>(),
    db.prepare("SELECT COUNT(*) AS value FROM analysis_jobs WHERE organization_id = ? AND created_at >= ? AND created_at < ? AND idempotency_key NOT LIKE 'material-import:%'").bind(organizationId, monthStart, nextMonthStart).first<{ value: number }>(),
    db.prepare("SELECT COUNT(*) AS value FROM model_calls WHERE organization_id = ? AND created_at >= ?").bind(organizationId, monthStart).first<{ value: number }>(),
    db.prepare("SELECT COALESCE(SUM(MAX(size_bytes,0)), 0) AS value FROM media_assets WHERE organization_id = ? AND status = 'active'").bind(organizationId).first<{ value: number }>(),
  ]);
  return { projects: projects?.value ?? 0, members: members?.value ?? 0, analyses: analyses?.value ?? 0, modelCalls: modelCalls?.value ?? 0, storageBytes: storage?.value ?? 0, monthStart };
}

export async function checkOrganizationQuota(organizationId: string, actorUserId: string, resource: "projects" | "members" | "analyses" | "modelCalls" | "storageBytes", increment = 1) {
  const [capacity, usage] = await Promise.all([getOrganizationCapacity(organizationId, actorUserId), readOrganizationUsage(organizationId)]);
  const limit = resource === "projects" ? capacity.project_quota
    : resource === "members" ? capacity.member_quota
      : resource === "analyses" ? capacity.monthly_analysis_quota
        : resource === "modelCalls" ? capacity.monthly_model_call_quota
          : capacity.storage_quota_bytes;
  const current = usage[resource];
  return { allowed: current + increment <= limit, current, limit, capacity, usage };
}
