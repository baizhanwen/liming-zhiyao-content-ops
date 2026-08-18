import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { canManageProjectKnowledge } from "../../../../lib/content-ops";
import { analyzePublishedCopy, publishedCopyPerformanceScore, readPublishedCopyPerformance, safeMonetizationTypes, updatePublishedCopyPerformanceSchema, type PublishedCopyRecord } from "../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

function present(record: PublishedCopyRecord) {
  const performance = readPublishedCopyPerformance(record.performance_json);
  return { ...record, monetization_types: safeMonetizationTypes(record.monetization_types_json), analysis: JSON.parse(record.analysis_json || "{}") as Record<string, unknown>, performance, performance_score: publishedCopyPerformanceScore(performance).score };
}

export async function PATCH(request: Request, context: { params: Promise<{ recordId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新历史文案效果。", 401);
  try {
    const parsed = updatePublishedCopyPerformanceSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_PUBLISHED_COPY_UPDATE", parsed.error.issues[0]?.message || "效果数据格式无效。", 400);
    const input = parsed.data; const access = await getProjectAccess(identity.authSubject, input.organizationId, input.projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能更新历史文案效果。", 403);
    const { recordId } = await context.params; const db = getD1();
    const record = await db.prepare(`SELECT id, title, body, platform, content_format, source_type, published_at, external_url,
      character_count, paragraph_count, monetization_types_json, monetization_detail, analysis_json, performance_json, created_at, updated_at
      FROM published_copy_records WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL`)
      .bind(recordId, input.organizationId, input.projectId).first<PublishedCopyRecord>();
    if (!record) return apiError("PUBLISHED_COPY_NOT_FOUND", "历史发布文案不存在或已经删除。", 404);
    const monetizationTypes = input.monetizationTypes ?? safeMonetizationTypes(record.monetization_types_json);
    const analysis = analyzePublishedCopy(record.body, monetizationTypes); const performance = Object.fromEntries(Object.entries(input.performance).filter(([, value]) => typeof value === "number"));
    const user = await ensureUser(identity); const now = new Date().toISOString(); const monetizationDetail = input.monetizationDetail ?? record.monetization_detail;
    await db.batch([
      db.prepare("UPDATE published_copy_records SET monetization_types_json = ?, monetization_detail = ?, analysis_json = ?, performance_json = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL")
        .bind(JSON.stringify(analysis.monetizationTypes), monetizationDetail || null, JSON.stringify(analysis), JSON.stringify(performance), user.id, now, recordId, input.organizationId, input.projectId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'published_copy.performance_updated', 'published_copy', ?, ?, ?)")
        .bind(crypto.randomUUID(), input.organizationId, input.projectId, user.id, recordId, JSON.stringify({ performance, monetizationTypes: analysis.monetizationTypes }), now),
    ]);
    return Response.json({ record: present({ ...record, monetization_types_json: JSON.stringify(analysis.monetizationTypes), monetization_detail: monetizationDetail || null, analysis_json: JSON.stringify(analysis), performance_json: JSON.stringify(performance), updated_at: now }) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ recordId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再删除历史发布文案。", 401);
  try {
    const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() || ""; const projectId = url.searchParams.get("projectId")?.trim() || "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canManageProjectKnowledge(access)) return apiError("MANAGE_ACCESS_REQUIRED", "只有项目负责人或管理员可以删除历史发布文案。", 403);
    const { recordId } = await context.params; const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const result = await db.prepare("UPDATE published_copy_records SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(now, user.id, now, recordId, organizationId, projectId).run();
    if (!result.meta.changes) return apiError("PUBLISHED_COPY_NOT_FOUND", "历史发布文案不存在或已经删除。", 404);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'published_copy.deleted', 'published_copy', ?, '{}', ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, recordId, now).run();
    return Response.json({ deleted: true, id: recordId });
  } catch (error) { return errorResponse(error); }
}
