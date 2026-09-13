import { ensureUser, getD1, getOrganizationAccess, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问个人备忘。", 401);
  const url = new URL(request.url);
  const organizationId = text(url.searchParams.get("organizationId"), 100);
  const sourceType = text(url.searchParams.get("sourceType"), 40);
  const sourceId = text(url.searchParams.get("sourceId"), 100);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的个人备忘。", 403);
    const user = await ensureUser(identity);
    const clauses = ["memo.organization_id = ?", "memo.owner_user_id = ?", "memo.status != 'archived'"];
    const bindings: unknown[] = [organizationId, user.id];
    if (sourceType) { clauses.push("memo.source_type = ?"); bindings.push(sourceType); }
    if (sourceId) { clauses.push("memo.source_id = ?"); bindings.push(sourceId); }
    const rows = await getD1().prepare(`SELECT memo.*, project.name AS project_name FROM personal_memos memo LEFT JOIN projects project ON project.id = memo.project_id AND project.organization_id = memo.organization_id WHERE ${clauses.join(" AND ")} ORDER BY CASE memo.status WHEN 'active' THEN 0 ELSE 1 END, memo.updated_at DESC LIMIT 50`).bind(...bindings).all();
    return Response.json({ memos: rows.results });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再添加个人备忘。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    const content = text(payload.content, 2_000);
    const sourceType = payload.sourceType === "performance_report" ? "performance_report" : "manual";
    const sourceId = text(payload.sourceId, 100);
    const sourceLocator = text(payload.sourceLocator, 100);
    if (!organizationId || !content) return apiError("MEMO_REQUIRED", "备忘内容不能为空。", 400);
    const organizationAccess = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!organizationAccess) return apiError("ACCESS_DENIED", "无权在该公司添加个人备忘。", 403);
    if (projectId && !await getProjectAccess(identity.authSubject, organizationId, projectId)) return apiError("PROJECT_ACCESS_DENIED", "无权使用该企业空间的报告建议。", 403);
    const db = getD1();
    if (sourceType === "performance_report") {
      const match = /^recommendation:(\d{1,3})$/.exec(sourceLocator);
      if (!projectId || !sourceId || !match) return apiError("MEMO_SOURCE_REQUIRED", "报告建议来源不完整。", 400);
      const report = await db.prepare("SELECT recommendations_json FROM performance_reports WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1").bind(sourceId, organizationId, projectId).first<{ recommendations_json: string }>();
      if (!report) return apiError("REPORT_NOT_FOUND", "没有找到这份报告。", 404);
      let recommendations: unknown = [];
      try { recommendations = JSON.parse(report.recommendations_json); } catch { recommendations = []; }
      const sourceContent = Array.isArray(recommendations) ? recommendations[Number(match[1])] : null;
      if (sourceContent !== content) return apiError("MEMO_SOURCE_MISMATCH", "报告建议已经发生变化，请刷新后重试。", 409);
    }
    const user = await ensureUser(identity); const now = new Date().toISOString(); const id = crypto.randomUUID();
    const result = await db.prepare("INSERT OR IGNORE INTO personal_memos (id, organization_id, project_id, owner_user_id, content, source_type, source_id, source_locator, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)").bind(id, organizationId, projectId || null, user.id, content, sourceType, sourceId || null, sourceLocator || null, now, now).run();
    const memo = result.meta.changes
      ? await db.prepare("SELECT memo.*, project.name AS project_name FROM personal_memos memo LEFT JOIN projects project ON project.id = memo.project_id WHERE memo.id = ?").bind(id).first()
      : await db.prepare("SELECT memo.*, project.name AS project_name FROM personal_memos memo LEFT JOIN projects project ON project.id = memo.project_id WHERE memo.owner_user_id = ? AND memo.source_type = ? AND memo.source_id = ? AND memo.source_locator = ? LIMIT 1").bind(user.id, sourceType, sourceId, sourceLocator).first();
    return Response.json({ memo, created: Boolean(result.meta.changes) }, { status: result.meta.changes ? 201 : 200 });
  } catch (error) { return errorResponse(error); }
}
