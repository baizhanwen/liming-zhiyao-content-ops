import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManagePublishing, publicationRecordSchema } from "../../../../../lib/content-workflow";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再记录发布结果。", 401);
  try {
    const parsed = publicationRecordSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_PUBLICATION", parsed.error.issues[0]?.message || "发布记录参数无效。", 400);
    const { organizationId, projectId, publicationId, platform, status, externalId, externalUrl, publishedAt, errorMessage } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canManagePublishing(access)) return apiError("PUBLICATION_ACCESS_DENIED", "当前角色不能管理发布记录。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT c.status, c.current_version, v.id AS version_id FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.status NOT IN ('reviewed', 'archived')").bind(contentId, organizationId, projectId).first<{ status: string; current_version: number; version_id: string }>();
    if (!item) return apiError("CONTENT_NOT_PUBLISHABLE", "内容不存在或当前状态不能记录发布。", 409);
    if (status === "published" && !["publish_ready", "published"].includes(item.status)) return apiError("PUBLISH_READY_REQUIRED", "内容必须先通过审核并进入待发布状态。", 409);
    const existing = publicationId ? await db.prepare("SELECT id FROM publication_records WHERE id = ? AND content_item_id = ? AND organization_id = ? AND project_id = ?").bind(publicationId, contentId, organizationId, projectId).first<{ id: string }>() : null;
    if (publicationId && !existing) return apiError("PUBLICATION_NOT_FOUND", "发布记录不存在。", 404);
    const schedule = await db.prepare("SELECT id FROM content_schedules WHERE content_item_id = ? AND organization_id = ? AND project_id = ? AND status != 'cancelled' ORDER BY updated_at DESC LIMIT 1").bind(contentId, organizationId, projectId).first<{ id: string }>();
    const user = await ensureUser(identity); const now = new Date().toISOString(); const recordId = existing?.id ?? crypto.randomUUID(); const actualPublishedAt = status === "published" ? (publishedAt || now) : null;
    const statements = [existing
      ? db.prepare("UPDATE publication_records SET content_version_id = ?, schedule_id = ?, platform = ?, status = ?, external_id = ?, external_url = ?, published_at = ?, error_message = ?, updated_by = ?, updated_at = ? WHERE id = ? AND content_item_id = ? AND organization_id = ? AND project_id = ?").bind(item.version_id, schedule?.id || null, platform, status, externalId || null, externalUrl || null, actualPublishedAt, errorMessage || null, user.id, now, recordId, contentId, organizationId, projectId)
      : db.prepare("INSERT INTO publication_records (id, organization_id, project_id, content_item_id, content_version_id, schedule_id, platform, status, external_id, external_url, published_at, error_message, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(recordId, organizationId, projectId, contentId, item.version_id, schedule?.id || null, platform, status, externalId || null, externalUrl || null, actualPublishedAt, errorMessage || null, user.id, user.id, now, now),
    ];
    if (status === "published") {
      statements.push(db.prepare("UPDATE content_items SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('publish_ready', 'published')").bind(user.id, now, contentId, organizationId, projectId));
      if (schedule?.id) statements.push(db.prepare("UPDATE content_schedules SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(user.id, now, schedule.id, organizationId, projectId));
    }
    statements.push(db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.publication.saved', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ publicationId: recordId, platform, status, version: item.current_version }), now));
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("PUBLICATION_STATE_CHANGED", "发布记录已被其他成员更新，请刷新后重试。", 409);
    return Response.json({ publication: { id: recordId, content_item_id: contentId, content_version_id: item.version_id, schedule_id: schedule?.id || null, platform, status, external_id: externalId || null, external_url: externalUrl || null, published_at: actualPublishedAt, error_message: errorMessage || null, updated_at: now }, item: status === "published" ? { id: contentId, status: "published", updated_at: now } : null });
  } catch (error) { return errorResponse(error); }
}

