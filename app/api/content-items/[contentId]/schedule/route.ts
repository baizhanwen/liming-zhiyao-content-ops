import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManagePublishing, scheduleContentSchema } from "../../../../../lib/content-workflow";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再安排内容日历。", 401);
  try {
    const parsed = scheduleContentSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_SCHEDULE", parsed.error.issues[0]?.message || "排期参数无效。", 400);
    const { organizationId, projectId, platform, scheduledAt, timezone, status, notes } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canManagePublishing(access)) return apiError("SCHEDULE_ACCESS_DENIED", "当前角色不能管理内容排期。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT c.status, c.current_version, v.id AS version_id FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.status NOT IN ('published', 'reviewed', 'archived')").bind(contentId, organizationId, projectId).first<{ status: string; current_version: number; version_id: string }>();
    if (!item) return apiError("CONTENT_NOT_SCHEDULABLE", "内容不存在或当前状态不能排期。", 409);
    if (status === "ready" && item.status !== "publish_ready") return apiError("PUBLISH_READY_REQUIRED", "只有待发布内容才能标记为排期就绪。", 409);
    const current = await db.prepare("SELECT id FROM content_schedules WHERE content_item_id = ? AND organization_id = ? AND project_id = ? AND status != 'cancelled' ORDER BY updated_at DESC LIMIT 1").bind(contentId, organizationId, projectId).first<{ id: string }>();
    const user = await ensureUser(identity); const now = new Date().toISOString(); const scheduleId = current?.id ?? crypto.randomUUID();
    const statement = current
      ? db.prepare("UPDATE content_schedules SET content_version_id = ?, platform = ?, scheduled_at = ?, timezone = ?, status = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status != 'cancelled'").bind(item.version_id, platform, scheduledAt, timezone, status, notes || null, user.id, now, scheduleId, organizationId, projectId)
      : db.prepare("INSERT INTO content_schedules (id, organization_id, project_id, content_item_id, content_version_id, platform, scheduled_at, timezone, status, notes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(scheduleId, organizationId, projectId, contentId, item.version_id, platform, scheduledAt, timezone, status, notes || null, user.id, user.id, now, now);
    const results = await db.batch([
      statement,
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.schedule.saved', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ scheduleId, platform, scheduledAt, timezone, status, version: item.current_version }), now),
    ]);
    if (!results[0].meta.changes) return apiError("SCHEDULE_STATE_CHANGED", "排期已被其他成员更新，请刷新后重试。", 409);
    return Response.json({ schedule: { id: scheduleId, content_item_id: contentId, content_version_id: item.version_id, platform, scheduled_at: scheduledAt, timezone, status, notes: notes || null, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}

