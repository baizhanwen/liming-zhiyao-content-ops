import { getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { recommendTopicReferences } from "../../../../lib/topic-reference-policy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看推荐参考。", 401);
  const params = new URL(request.url).searchParams;
  const organizationId = params.get("organizationId")?.trim() || "", projectId = params.get("projectId")?.trim() || "", query = params.get("query")?.trim().slice(0, 160) || "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  if (query.length < 2) return apiError("TOPIC_TITLE_REQUIRED", "请先填写选题标题。", 400);
  try {
    if (!await getProjectAccess(identity.authSubject, organizationId, projectId)) return apiError("ACCESS_DENIED", "无权访问该项目。", 403);
    const rows = await getD1().prepare("SELECT k.id, k.title, k.category, v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL ORDER BY k.updated_at DESC LIMIT 100").bind(organizationId, projectId).all<{ id: string; title: string; category: string; body: string }>();
    return Response.json({ query, recommendations: recommendTopicReferences(query, rows.results) });
  } catch (error) { return errorResponse(error); }
}
