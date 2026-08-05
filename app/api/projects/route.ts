import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { checkOrganizationQuota } from "../../../lib/operations";

function organizationIdFrom(request: Request) { return new URL(request.url).searchParams.get("organizationId")?.trim() ?? ""; }

export async function GET(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问客户项目。", 401);
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的项目。", 403);
    const db = getD1();
    const adminSql = `
      SELECT p.id, p.name, p.client_name, p.status, p.service_starts_at, p.service_ends_at, p.content_target, p.created_at,
             COUNT(pm.id) AS member_count
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.status = 'active'
      WHERE p.organization_id = ? AND p.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.created_at DESC`;
    const memberSql = `
      SELECT p.id, p.name, p.client_name, p.status, p.service_starts_at, p.service_ends_at, p.content_target, p.created_at,
             COUNT(all_pm.id) AS member_count
      FROM projects p
      INNER JOIN project_members own_pm ON own_pm.project_id = p.id AND own_pm.user_id = ? AND own_pm.status = 'active'
      LEFT JOIN project_members all_pm ON all_pm.project_id = p.id AND all_pm.status = 'active'
      WHERE p.organization_id = ? AND p.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.created_at DESC`;
    const rows = access.organizationRole === "admin"
      ? await db.prepare(adminSql).bind(organizationId).all()
      : await db.prepare(memberSql).bind(access.userId, organizationId).all();
    return Response.json({ projects: rows.results, organizationRole: access.organizationRole });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建项目。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; name?: string; clientName?: string; serviceStartsAt?: string; serviceEndsAt?: string; contentTarget?: number };
    const organizationId = payload.organizationId?.trim() ?? "";
    const name = payload.name?.trim() ?? "";
    const clientName = payload.clientName?.trim() ?? "";
    if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
    if (name.length < 2 || name.length > 80) return apiError("INVALID_PROJECT_NAME", "项目名称需要 2 至 80 个字符。", 400);
    if (clientName.length < 2 || clientName.length > 80) return apiError("INVALID_CLIENT_NAME", "客户名称需要 2 至 80 个字符。", 400);
    const target = Number.isFinite(payload.contentTarget) ? Math.max(0, Math.min(999, Math.trunc(payload.contentTarget!))) : 0;
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以创建客户项目。", 403);
    const user = await ensureUser(identity);
    const quota = await checkOrganizationQuota(organizationId, user.id, "projects");
    if (!quota.allowed) return apiError("PROJECT_QUOTA_EXCEEDED", `当前套餐最多保留 ${quota.limit} 个运行中项目。`, 429, { usage: quota.current, limit: quota.limit });
    const db = getD1();
    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO projects (id, organization_id, name, client_name, status, service_starts_at, service_ends_at, content_target, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)").bind(projectId, organizationId, name, clientName, payload.serviceStartsAt || null, payload.serviceEndsAt || null, target, user.id, user.id, now, now),
      db.prepare("INSERT INTO project_members (id, organization_id, project_id, user_id, role, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, user.id, user.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'project.created', 'project', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ name, clientName }), now),
    ]);
    return Response.json({ project: { id: projectId, name, client_name: clientName, status: "active", content_target: target, member_count: 1 } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再管理项目。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; status?: string };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    if (!organizationId || !projectId || !["draft", "active", "paused", "archived"].includes(payload.status ?? "")) return apiError("INVALID_PROJECT_UPDATE", "项目范围或状态无效。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以修改项目状态。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const result = await db.prepare("UPDATE projects SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL").bind(payload.status, user.id, now, projectId, organizationId).run();
    if (!result.meta.changes) return apiError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'project.status_updated', 'project', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ status: payload.status }), now).run();
    return Response.json({ project: { id: projectId, status: payload.status, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
