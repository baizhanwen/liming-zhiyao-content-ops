import { getD1, ensureUser, makeSlug } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { planPresets } from "../../../lib/operations";

export async function GET(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问公司数据。", 401);
  try {
    const user = await ensureUser(identity);
    const rows = await getD1().prepare(`
      SELECT o.id, o.name, o.slug, o.status, om.role, o.created_at
      FROM organization_members om
      INNER JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = ? AND om.status = 'active' AND o.status = 'active'
      ORDER BY o.created_at ASC
    `).bind(user.id).all();
    return Response.json({ organizations: rows.results });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建公司。", 401);
  try {
    const payload = await request.json() as { name?: string };
    const name = payload.name?.trim() ?? "";
    if (name.length < 2 || name.length > 80) return apiError("INVALID_NAME", "公司名称需要 2 至 80 个字符。", 400);

    const user = await ensureUser(identity);
    const db = getD1();
    const organizationId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO organizations (id, name, slug, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").bind(organizationId, name, makeSlug(name, organizationId), user.id, now, now),
      db.prepare("INSERT INTO organization_members (id, organization_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, user.id, user.id, now, now),
      db.prepare("INSERT INTO organization_settings (id, organization_id, plan_code, project_quota, member_quota, monthly_analysis_quota, monthly_model_call_quota, storage_quota_bytes, retention_days, failed_job_alert_threshold, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'team', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, planPresets.team.projectQuota, planPresets.team.memberQuota, planPresets.team.monthlyAnalysisQuota, planPresets.team.monthlyModelCallQuota, planPresets.team.storageQuotaBytes, planPresets.team.retentionDays, planPresets.team.failedJobAlertThreshold, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'organization.created', 'organization', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, organizationId, JSON.stringify({ name }), now),
    ]);
    return Response.json({ organization: { id: organizationId, name, role: "admin", status: "active" } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
