import { getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { canInternalReview, canManagePublishing, canSubmitContent } from "../../../lib/content-workflow";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问协作工作台。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的协作工作台。", 403);
    const clientOnly = false;
    const db = getD1();
    const [items, reviews, comments, schedules, publications] = await Promise.all([
      db.prepare(`
        SELECT c.id, c.topic_id, c.title, c.status, c.current_version, c.assignee_user_id, c.due_at, c.updated_at,
          v.id AS version_id, v.generation_mode, v.pack_json, v.full_script, v.short_script, v.change_summary, v.created_at AS version_created_at,
          t.source_type AS topic_source_type, t.source_ref AS topic_source_ref,
          (SELECT COUNT(*) FROM content_citations cc WHERE cc.organization_id = c.organization_id AND cc.project_id = c.project_id AND cc.content_item_id = c.id AND cc.content_version_id = v.id) AS citation_count
        FROM content_items c
        INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id
        INNER JOIN topic_ideas t ON t.id = c.topic_id AND t.organization_id = c.organization_id AND t.project_id = c.project_id
        WHERE c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.status != 'archived'
        ORDER BY c.updated_at DESC LIMIT 300
      `).bind(organizationId, projectId).all(),
      db.prepare(`
        SELECT r.id, r.content_item_id, r.content_version_id, r.review_stage, r.round, r.decision, r.note, r.requested_at, r.decided_at,
          requester.display_name AS requested_by_name, decider.display_name AS decided_by_name
        FROM content_reviews r
        INNER JOIN users requester ON requester.id = r.requested_by
        LEFT JOIN users decider ON decider.id = r.decided_by
        WHERE r.organization_id = ? AND r.project_id = ? AND r.review_stage = 'internal' AND ? = 0
        ORDER BY r.requested_at DESC LIMIT 1000
      `).bind(organizationId, projectId, clientOnly ? 1 : 0).all(),
      db.prepare(`
        SELECT c.id, c.content_item_id, c.content_version_id, c.visibility, c.body, c.anchor_json, c.resolved_at, c.created_at, c.updated_at,
          u.display_name AS author_name, u.email AS author_email
        FROM content_comments c INNER JOIN users u ON u.id = c.author_user_id
        WHERE c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND (? = 0 OR c.visibility = 'client')
        ORDER BY c.created_at DESC LIMIT 2000
      `).bind(organizationId, projectId, clientOnly ? 1 : 0).all(),
      db.prepare("SELECT id, content_item_id, content_version_id, platform, scheduled_at, timezone, status, notes, updated_at FROM content_schedules WHERE organization_id = ? AND project_id = ? ORDER BY scheduled_at ASC LIMIT 1000").bind(organizationId, projectId).all(),
      db.prepare("SELECT id, content_item_id, content_version_id, schedule_id, platform, status, external_id, external_url, published_at, error_message, updated_at FROM publication_records WHERE organization_id = ? AND project_id = ? ORDER BY updated_at DESC LIMIT 1000").bind(organizationId, projectId).all(),
    ]);
    return Response.json({
      items: items.results,
      reviews: reviews.results,
      comments: comments.results,
      schedules: schedules.results,
      publications: publications.results,
      permissions: {
        canSubmit: canSubmitContent(access),
        canInternalReview: canInternalReview(access),
        canManagePublishing: canManagePublishing(access),
        clientOnly,
      },
    });
  } catch (error) { return errorResponse(error); }
}
