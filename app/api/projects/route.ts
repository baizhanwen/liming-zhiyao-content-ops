import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { checkOrganizationQuota, getOrganizationCapacity } from "../../../lib/operations";

function organizationIdFrom(request: Request) { return new URL(request.url).searchParams.get("organizationId")?.trim() ?? ""; }

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问企业空间。", 401);
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的项目。", 403);
    const db = getD1();
    const adminSql = `
      SELECT p.id, p.name, p.client_name, p.status, p.service_starts_at, p.service_ends_at, p.content_target, p.created_at,
             COUNT(pm.id) AS member_count
      FROM projects p LEFT JOIN project_members pm ON pm.organization_id = p.organization_id AND pm.project_id = p.id AND pm.status = 'active'
        AND EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = pm.organization_id AND om.user_id = pm.user_id AND om.role = 'member' AND om.status = 'active')
      WHERE p.organization_id = ? AND p.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.created_at DESC`;
    const memberSql = `
      SELECT p.id, p.name, p.client_name, p.status, p.service_starts_at, p.service_ends_at, p.content_target, p.created_at,
             COUNT(all_pm.id) AS member_count
      FROM projects p
      INNER JOIN project_members own_pm ON own_pm.organization_id = p.organization_id AND own_pm.project_id = p.id AND own_pm.user_id = ? AND own_pm.status = 'active'
      LEFT JOIN project_members all_pm ON all_pm.organization_id = p.organization_id AND all_pm.project_id = p.id AND all_pm.status = 'active'
        AND EXISTS (SELECT 1 FROM organization_members all_om WHERE all_om.organization_id = all_pm.organization_id AND all_om.user_id = all_pm.user_id AND all_om.role = 'member' AND all_om.status = 'active')
      WHERE p.organization_id = ? AND p.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.created_at DESC`;
    const rows = access.organizationRole === "admin"
      ? await db.prepare(adminSql).bind(organizationId).all()
      : await db.prepare(memberSql).bind(access.userId, organizationId).all();
    return Response.json({ projects: rows.results, organizationRole: access.organizationRole });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建项目。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; name?: string; serviceStartsAt?: string; serviceEndsAt?: string; contentTarget?: number };
    const organizationId = payload.organizationId?.trim() ?? "";
    const name = payload.name?.trim() ?? "";
    // client_name remains as an internal compatibility column for existing
    // generation and search code. In an enterprise-delivered installation the
    // enterprise space name is the single user-facing identity.
    const clientName = name;
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    if (name.length < 2 || name.length > 80) return apiError("INVALID_PROJECT_NAME", "空间名称需要 2 至 80 个字符。", 400);
    const target = Number.isFinite(payload.contentTarget) ? Math.max(0, Math.min(999, Math.trunc(payload.contentTarget!))) : 0;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以创建企业空间。", 403);
    const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "projects");
    if (!quota.allowed) return apiError("PROJECT_QUOTA_EXCEEDED", `当前套餐最多保留 ${quota.limit} 个运行中项目。`, 429, { usage: quota.current, limit: quota.limit });
    const db = getD1();
    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(`INSERT INTO projects (id, organization_id, name, client_name, status, service_starts_at, service_ends_at, content_target, created_by, updated_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM projects WHERE organization_id = ? AND deleted_at IS NULL AND status != 'archived') < ?`)
        .bind(projectId, organizationId, name, clientName, payload.serviceStartsAt || null, payload.serviceEndsAt || null, target, user.id, user.id, now, now, organizationId, quota.limit),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'project.created', 'project', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ name }), now),
    ]);
    if (!results[0].meta.changes) return apiError("PROJECT_QUOTA_EXCEEDED", `当前套餐最多保留 ${quota.limit} 个运行中项目。`, 429, { limit: quota.limit });
    return Response.json({ project: { id: projectId, name, client_name: clientName, status: "active", content_target: target, member_count: 0 } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再管理项目。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; status?: string };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    if (!organizationId || !projectId || !["draft", "active", "paused", "archived"].includes(payload.status ?? "")) return apiError("INVALID_PROJECT_UPDATE", "项目范围或状态无效。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以修改项目状态。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const capacity = await getOrganizationCapacity(organizationId, user.id);
    const results = await db.batch([
      db.prepare(`UPDATE projects SET status = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
          AND (status != 'archived' OR ? = 'archived' OR
            (SELECT COUNT(*) FROM projects WHERE organization_id = ? AND deleted_at IS NULL AND status != 'archived') < ?)`)
        .bind(payload.status, user.id, now, projectId, organizationId, payload.status, organizationId, capacity.project_quota),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'project.status_updated', 'project', ?, ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ status: payload.status }), now),
    ]);
    if (!results[0].meta.changes) {
      const existing = await db.prepare("SELECT 1 AS found FROM projects WHERE id = ? AND organization_id = ? AND deleted_at IS NULL").bind(projectId, organizationId).first();
      if (!existing) return apiError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      return apiError("PROJECT_QUOTA_EXCEEDED", `当前套餐最多保留 ${capacity.project_quota} 个运行中项目，请先归档其他项目。`, 429, { limit: capacity.project_quota });
    }
    return Response.json({ project: { id: projectId, status: payload.status, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
