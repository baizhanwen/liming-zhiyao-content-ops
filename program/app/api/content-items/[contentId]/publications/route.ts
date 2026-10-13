import { ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { canManagePublishing, publicationRecordSchema } from "../../../../../lib/content-workflow";
import { analyzePublishedCopy } from "../../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../../lib/request-auth";

import { commitContentWorkflowWrite, nextWriteTimestamp } from "../../../../../lib/content-workflow-write";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再记录发布结果。", 401);
  try {
    const parsed = publicationRecordSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_PUBLICATION", parsed.error.issues[0]?.message || "发布记录参数无效。", 400);
    const { organizationId, projectId, publicationId, platform, status, externalId, externalUrl, publishedAt, errorMessage, expectedVersion, expectedUpdatedAt } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canManagePublishing(access)) return apiError("PUBLICATION_ACCESS_DENIED", "当前角色不能管理发布记录。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT c.status, c.current_version, c.updated_at, c.title, v.id AS version_id, v.full_script, v.short_script FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL AND c.status NOT IN ('reviewed', 'archived')").bind(contentId, organizationId, projectId).first<{ status: string; current_version: number; updated_at:string; title: string; version_id: string; full_script: string; short_script: string }>();
    if (!item) return apiError("CONTENT_NOT_PUBLISHABLE", "内容不存在或当前状态不能记录发布。", 409);
    if (expectedVersion !== undefined && expectedVersion !== item.current_version) return apiError("CONTENT_VERSION_CONFLICT", "稿件已更新，请刷新并核对当前版本后再登记发布。", 409);
    if (status === "published" && !["publish_ready", "published"].includes(item.status)) return apiError("PUBLISH_READY_REQUIRED", "内容必须先通过审核并进入待发布状态。", 409);
    if (status === "published" && !await db.prepare("SELECT id FROM content_reviews WHERE content_version_id = ? AND organization_id = ? AND project_id = ? AND review_stage = 'internal' AND decision = 'approved'").bind(item.version_id, organizationId, projectId).first()) return apiError("CURRENT_VERSION_APPROVAL_REQUIRED", "当前版本尚未通过内部审核，请先重新提交审核。", 409);
    const existing = publicationId ? await db.prepare("SELECT id, content_version_id, schedule_id, updated_at FROM publication_records WHERE id = ? AND content_item_id = ? AND organization_id = ? AND project_id = ?").bind(publicationId, contentId, organizationId, projectId).first<{ id:string; content_version_id:string; schedule_id:string|null; updated_at:string }>() : null;
    if (publicationId && !existing) return apiError("PUBLICATION_NOT_FOUND", "发布记录不存在。", 404);
    if (existing && existing.content_version_id !== item.version_id) return apiError("PUBLICATION_VERSION_MISMATCH", "这条发布记录属于旧稿件版本，请为当前版本新建发布记录。", 409);
    if (existing && !expectedUpdatedAt) return apiError("PUBLICATION_REVISION_REQUIRED","请刷新发布记录并携带读取到的版本后再修改。",400);
    if (existing && existing.updated_at!==expectedUpdatedAt) return apiError("PUBLICATION_STATE_CHANGED","发布记录已被更新，本次未覆盖，请刷新核对。",409);
    const scheduleQuery = "SELECT id,updated_at FROM content_schedules WHERE content_item_id=? AND organization_id=? AND project_id=? AND content_version_id=? AND platform=? AND (status IN ('planned','ready') OR (id=? AND status='published')) ORDER BY updated_at DESC,id LIMIT 1";
    const scheduleBindings = [contentId,organizationId,projectId,item.version_id,platform,existing?.schedule_id||""];
    const schedule = await db.prepare(scheduleQuery).bind(...scheduleBindings).first<{id:string;updated_at:string}>();
    const user=await ensureUser(identity),now=nextWriteTimestamp(existing?.updated_at || item.updated_at),recordId=existing?.id??crypto.randomUUID(),actualPublishedAt=status==="published"?(publishedAt||new Date().toISOString()):null;
    const mutate = (operationSql:string,auditId:string) => {
    const statements = [existing
      ? db.prepare(`UPDATE publication_records SET schedule_id = ?, platform = ?, status = ?, external_id = ?, external_url = ?, published_at = ?, error_message = ?, updated_by = ?, updated_at = ? WHERE id = ? AND content_item_id = ? AND organization_id = ? AND project_id = ? AND content_version_id = ? AND ${operationSql}`).bind(schedule?.id || null, platform, status, externalId || null, externalUrl || null, actualPublishedAt, errorMessage || null, user.id, now, recordId, contentId, organizationId, projectId, item.version_id, auditId)
      : db.prepare(`INSERT INTO publication_records (id, organization_id, project_id, content_item_id, content_version_id, schedule_id, platform, status, external_id, external_url, published_at, error_message, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${operationSql}`).bind(recordId, organizationId, projectId, contentId, item.version_id, schedule?.id || null, platform, status, externalId || null, externalUrl || null, actualPublishedAt, errorMessage || null, user.id, user.id, now, now, auditId),
    ];
    if (status === "published") {
      statements.push(db.prepare(`UPDATE content_items SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ? AND status IN ('publish_ready', 'published') AND ${operationSql}`).bind(user.id, now, contentId, organizationId, projectId, item.current_version, auditId));
      if (schedule?.id) statements.push(db.prepare(`UPDATE content_schedules SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND ${operationSql}`).bind(user.id, now, schedule.id, organizationId, projectId, auditId));
      const historicalBody = item.full_script.trim() || item.short_script.trim(); const historicalAnalysis = analyzePublishedCopy(historicalBody);
      statements.push(db.prepare(`INSERT INTO published_copy_records (
        id, organization_id, project_id, content_item_id, content_version_id, publication_id, source_type,
        title, body, platform, content_format, published_at, external_url, character_count, paragraph_count,
        monetization_types_json, analysis_json, performance_json, created_by, updated_by, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'publication', ?, ?, ?, 'spoken_script', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ? WHERE ${operationSql}
      ON CONFLICT(publication_id) DO UPDATE SET
        content_version_id = excluded.content_version_id, title = excluded.title, body = excluded.body,
        platform = excluded.platform, published_at = excluded.published_at, external_url = excluded.external_url,
        character_count = excluded.character_count, paragraph_count = excluded.paragraph_count,
        monetization_types_json = excluded.monetization_types_json, analysis_json = excluded.analysis_json,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at, deleted_at = NULL`)
        .bind(crypto.randomUUID(), organizationId, projectId, contentId, item.version_id, recordId, item.title, historicalBody, platform, actualPublishedAt, externalUrl || null, historicalAnalysis.characterCount, historicalAnalysis.paragraphCount, JSON.stringify(historicalAnalysis.monetizationTypes), JSON.stringify(historicalAnalysis), user.id, user.id, now, now, auditId));
    }
    return statements;
    };
    const guard = `EXISTS(SELECT 1 FROM content_items c JOIN content_versions v ON v.content_item_id=c.id AND v.version=c.current_version AND v.organization_id=c.organization_id AND v.project_id=c.project_id
      WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.current_version=? AND v.id=? AND c.status=? AND c.updated_at=? AND c.deleted_at IS NULL)
      ${status==="published"?"AND EXISTS(SELECT 1 FROM content_reviews WHERE content_version_id=? AND organization_id=? AND project_id=? AND review_stage='internal' AND decision='approved')":""}
      ${existing?"AND EXISTS(SELECT 1 FROM publication_records WHERE id=? AND content_item_id=? AND organization_id=? AND project_id=? AND content_version_id=? AND updated_at=?)":""}
      AND ${schedule?"EXISTS(SELECT 1 FROM ("+scheduleQuery+") chosen WHERE chosen.id=? AND chosen.updated_at=?)":"NOT EXISTS("+scheduleQuery+")"}`;
    const committed=await commitContentWorkflowWrite(db,{
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:contentId,version:now,
      action:"content.publication.saved",targetType:"content_item",metadata:{publicationId:recordId,platform,status,version:item.current_version},guard,
      bindings:[contentId,organizationId,projectId,item.current_version,item.version_id,item.status,item.updated_at,
        ...(status==="published"?[item.version_id,organizationId,projectId]:[]),
        ...(existing?[recordId,contentId,organizationId,projectId,item.version_id,existing.updated_at]:[]),
        ...scheduleBindings,...(schedule?[schedule.id,schedule.updated_at]:[])],mutate,
    });
    if (!committed) return apiError("PUBLICATION_STATE_CHANGED","稿件、发布记录或匹配排期已被更新，本次未保存。请刷新核对后再操作。",409);
    return Response.json({ publication: { id: recordId, content_item_id: contentId, content_version_id: item.version_id, schedule_id: schedule?.id || null, platform, status, external_id: externalId || null, external_url: externalUrl || null, published_at: actualPublishedAt, error_message: errorMessage || null, updated_at: now }, item: status === "published" ? { id: contentId, status: "published", updated_at: now } : null });
  } catch (error) { return errorResponse(error); }
}
