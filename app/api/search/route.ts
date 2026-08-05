import { getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再搜索。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const query = url.searchParams.get("q")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  if (query.length < 2 || query.length > 80) return apiError("INVALID_QUERY", "搜索词需要 2 至 80 个字符。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权搜索该公司的数据。", 403);
    const db = getD1(); const like = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const scope = (alias: string) => access.organizationRole === "admin" ? "" : ` AND EXISTS (SELECT 1 FROM project_members own WHERE own.organization_id = ${alias}.organization_id AND own.project_id = ${alias}.project_id AND own.user_id = ? AND own.status = 'active')`;
    const scopeValues = access.organizationRole === "admin" ? [] : [access.userId];
    const [projects, contents, topics, videos, knowledge, members] = await Promise.all([
      db.prepare(`SELECT 'project' AS type, p.id, p.name AS title, p.client_name AS subtitle, '/projects' AS href FROM projects p WHERE p.organization_id = ? AND p.deleted_at IS NULL AND (p.name LIKE ? ESCAPE '\\' OR p.client_name LIKE ? ESCAPE '\\')${scope("p")} LIMIT 10`).bind(organizationId, like, like, ...scopeValues).all(),
      db.prepare(`SELECT 'content' AS type, c.id, c.title, p.name AS subtitle, '/content' AS href FROM content_items c INNER JOIN projects p ON p.id = c.project_id WHERE c.organization_id = ? AND c.deleted_at IS NULL AND c.title LIKE ? ESCAPE '\\'${scope("c")} LIMIT 15`).bind(organizationId, like, ...scopeValues).all(),
      db.prepare(`SELECT 'topic' AS type, t.id, t.title, p.name AS subtitle, '/topics' AS href FROM topic_ideas t INNER JOIN projects p ON p.id = t.project_id WHERE t.organization_id = ? AND t.deleted_at IS NULL AND (t.title LIKE ? ESCAPE '\\' OR COALESCE(t.angle,'') LIKE ? ESCAPE '\\')${scope("t")} LIMIT 15`).bind(organizationId, like, like, ...scopeValues).all(),
      db.prepare(`SELECT 'video' AS type, v.id, COALESCE(v.title, v.source_url, '未命名视频') AS title, p.name AS subtitle, '/analysis/' || v.id AS href FROM videos v INNER JOIN projects p ON p.id = v.project_id WHERE v.organization_id = ? AND v.deleted_at IS NULL AND (COALESCE(v.title,'') LIKE ? ESCAPE '\\' OR COALESCE(v.author_name,'') LIKE ? ESCAPE '\\')${scope("v")} LIMIT 15`).bind(organizationId, like, like, ...scopeValues).all(),
      db.prepare(`SELECT 'knowledge' AS type, k.id, k.title, p.name AS subtitle, '/knowledge' AS href FROM knowledge_items k INNER JOIN projects p ON p.id = k.project_id WHERE k.organization_id = ? AND k.deleted_at IS NULL AND k.title LIKE ? ESCAPE '\\'${scope("k")} LIMIT 15`).bind(organizationId, like, ...scopeValues).all(),
      access.organizationRole === "admin" ? db.prepare("SELECT 'member' AS type, u.id, COALESCE(u.display_name,u.email) AS title, u.email AS subtitle, '/members' AS href FROM organization_members om INNER JOIN users u ON u.id = om.user_id WHERE om.organization_id = ? AND om.status != 'removed' AND (u.email LIKE ? ESCAPE '\\' OR COALESCE(u.display_name,'') LIKE ? ESCAPE '\\') LIMIT 10").bind(organizationId, like, like).all() : Promise.resolve({ results: [] }),
    ]);
    return Response.json({ query, results: [...projects.results, ...contents.results, ...topics.results, ...videos.results, ...knowledge.results, ...members.results] });
  } catch (error) { return errorResponse(error); }
}
