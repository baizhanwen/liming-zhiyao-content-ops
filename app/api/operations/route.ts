import { env } from "cloudflare:workers";
import { z } from "zod";
import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { getOrganizationCapacity, planPresets, readOrganizationUsage } from "../../../lib/operations";
import { readRequestIdentity } from "../../../lib/request-auth";

const updateSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(2).max(80),
  planCode: z.enum(["starter", "team", "scale"]),
});

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问系统运营中心。", 401);
  const organizationId = new URL(request.url).searchParams.get("organizationId")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的运行数据。", 403);
    if (access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以查看系统运行、配额和完整审计。", 403);
    const user = await ensureUser(identity);
    const db = getD1();
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const [organization, capacity, usage, failedJobs, staleJobs, failedModels, failedPublications, overdueReviews, recentAudit, lastWorkerHeartbeat] = await Promise.all([
      db.prepare("SELECT id, name, slug, status, created_at, updated_at FROM organizations WHERE id = ?").bind(organizationId).first<Record<string, unknown>>(),
      getOrganizationCapacity(organizationId, user.id),
      readOrganizationUsage(organizationId),
      db.prepare("SELECT COUNT(*) AS value FROM analysis_jobs WHERE organization_id = ? AND status = 'failed' AND updated_at >= ?").bind(organizationId, since24h).first<{ value: number }>(),
      db.prepare("SELECT COUNT(*) AS value FROM analysis_jobs WHERE organization_id = ? AND status IN ('downloading','processing','transcribing','extracting','analyzing') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)").bind(organizationId, staleBefore).first<{ value: number }>(),
      db.prepare("SELECT COUNT(*) AS value FROM model_calls WHERE organization_id = ? AND status = 'failed' AND created_at >= ?").bind(organizationId, since24h).first<{ value: number }>(),
      db.prepare("SELECT COUNT(*) AS value FROM publication_records WHERE organization_id = ? AND status = 'failed' AND updated_at >= ?").bind(organizationId, since24h).first<{ value: number }>(),
      db.prepare("SELECT COUNT(*) AS value FROM content_reviews r INNER JOIN content_items c ON c.id = r.content_item_id AND c.organization_id = r.organization_id AND c.project_id = r.project_id WHERE r.organization_id = ? AND r.decision = 'pending' AND c.due_at IS NOT NULL AND c.due_at < ?").bind(organizationId, now.toISOString()).first<{ value: number }>(),
      db.prepare(`SELECT a.id, a.action, a.target_type, a.target_id, a.project_id, a.metadata_json, a.created_at, u.email AS actor_email, p.name AS project_name
        FROM audit_logs a INNER JOIN users u ON u.id = a.actor_user_id LEFT JOIN projects p ON p.id = a.project_id
        WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 30`).bind(organizationId).all(),
      db.prepare("SELECT MAX(last_heartbeat_at) AS value FROM analysis_jobs WHERE organization_id = ?").bind(organizationId).first<{ value: string | null }>(),
    ]);

    const alerts: Array<{ code: string; severity: "warning" | "critical"; title: string; message: string }> = [];
    const failedJobCount = failedJobs?.value ?? 0;
    if (failedJobCount >= capacity.failed_job_alert_threshold) alerts.push({ code: "FAILED_ANALYSIS_JOBS", severity: "critical", title: "分析任务失败偏多", message: `过去 24 小时有 ${failedJobCount} 个分析任务失败，请检查分析服务和模型配置。` });
    if ((staleJobs?.value ?? 0) > 0) alerts.push({ code: "STALE_ANALYSIS_JOBS", severity: "critical", title: "分析任务失去心跳", message: `${staleJobs?.value ?? 0} 个任务超过 10 分钟没有心跳。` });
    if ((failedModels?.value ?? 0) > 0) alerts.push({ code: "FAILED_MODEL_CALLS", severity: "warning", title: "内容模型调用失败", message: `过去 24 小时有 ${failedModels?.value ?? 0} 次模型调用失败。` });
    if ((failedPublications?.value ?? 0) > 0) alerts.push({ code: "FAILED_PUBLICATIONS", severity: "warning", title: "发布记录存在失败", message: `过去 24 小时有 ${failedPublications?.value ?? 0} 条发布记录失败。` });
    if ((overdueReviews?.value ?? 0) > 0) alerts.push({ code: "OVERDUE_REVIEWS", severity: "warning", title: "审核已经逾期", message: `${overdueReviews?.value ?? 0} 条待审核内容超过截止时间。` });
    const quotaPairs = [
      ["PROJECT_QUOTA", "项目数量", usage.projects, capacity.project_quota],
      ["MEMBER_QUOTA", "成员数量", usage.members, capacity.member_quota],
      ["ANALYSIS_QUOTA", "本月分析", usage.analyses, capacity.monthly_analysis_quota],
      ["MODEL_QUOTA", "本月模型调用", usage.modelCalls, capacity.monthly_model_call_quota],
      ["STORAGE_QUOTA", "媒体存储", usage.storageBytes, capacity.storage_quota_bytes],
    ] as const;
    for (const [code, label, current, limit] of quotaPairs) if (limit > 0 && current / limit >= 0.8) alerts.push({ code, severity: current >= limit ? "critical" : "warning", title: `${label}接近配额`, message: `已使用 ${current} / ${limit}，请清理数据或调整套餐。` });

    const runtime = env as typeof env & { ANALYZER_SERVICE_TOKEN?: string; CONTENT_MODEL_API_KEY?: string; CONTENT_MODEL_BASE_URL?: string; CONTENT_MODEL_NAME?: string };
    return Response.json({
      organization, organizationRole: access.organizationRole, capacity, usage, alerts,
      services: {
        database: "ready",
        analyzerCredentialConfigured: Boolean(runtime.ANALYZER_SERVICE_TOKEN?.trim()),
        contentModelConfigured: Boolean(runtime.CONTENT_MODEL_API_KEY?.trim() && runtime.CONTENT_MODEL_BASE_URL?.trim() && runtime.CONTENT_MODEL_NAME?.trim()),
        lastWorkerHeartbeat: lastWorkerHeartbeat?.value ?? null,
      },
      recentAudit: recentAudit.results,
    });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再修改公司设置。", 401);
  try {
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_SETTINGS", "公司名称或套餐设置无效。", 400);
    const { organizationId, name, planCode } = parsed.data;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以修改系统设置。", 403);
    const user = await ensureUser(identity); const db = getD1(); const preset = planPresets[planCode]; const now = new Date().toISOString();
    await getOrganizationCapacity(organizationId, user.id);
    await db.batch([
      db.prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ? AND status = 'active'").bind(name, now, organizationId),
      db.prepare("UPDATE organization_settings SET plan_code = ?, project_quota = ?, member_quota = ?, monthly_analysis_quota = ?, monthly_model_call_quota = ?, storage_quota_bytes = ?, retention_days = ?, failed_job_alert_threshold = ?, updated_by = ?, updated_at = ? WHERE organization_id = ?").bind(planCode, preset.projectQuota, preset.memberQuota, preset.monthlyAnalysisQuota, preset.monthlyModelCallQuota, preset.storageQuotaBytes, preset.retentionDays, preset.failedJobAlertThreshold, user.id, now, organizationId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'organization.settings_updated', 'organization', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, organizationId, JSON.stringify({ name, planCode }), now),
    ]);
    return Response.json({ organization: { id: organizationId, name }, planCode, capacity: { ...preset } });
  } catch (error) { return errorResponse(error); }
}
