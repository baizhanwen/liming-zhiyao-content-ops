import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { analysisReportSourceText, saveContentVersionSchema } from "../../../../lib/content-production";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存内容。", 401);
  try {
    const parsed = saveContentVersionSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_CONTENT_VERSION", "生产包结构不完整或字段过长。", 400);
    const { organizationId, projectId, pack, changeSummary } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能修改内容。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT id, topic_id, current_version FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL AND status NOT IN ('published', 'reviewed', 'archived')").bind(contentId, organizationId, projectId).first<{ id: string; topic_id: string; current_version: number }>();
    if (!item) return apiError("CONTENT_NOT_EDITABLE", "内容不存在、已归档或当前状态不可编辑。", 409);
    const allowed = new Map<string, string>();
    const sourceRows = await db.prepare(`
      SELECT 'topic:' || id AS source_key, title || char(10) || COALESCE(angle, '') || char(10) || COALESCE(pillar, '') || char(10) || COALESCE(audience, '') || char(10) || COALESCE(objective, '') || char(10) || COALESCE(hook, '') || char(10) || COALESCE(rationale, '') AS source_text FROM topic_ideas WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
      UNION ALL SELECT 'knowledge:' || k.id, v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
      UNION ALL SELECT 'video_analysis:' || a.id, a.report_json FROM video_analyses a INNER JOIN videos v ON v.id = a.video_id AND v.organization_id = a.organization_id AND v.project_id = a.project_id WHERE a.organization_id = ? AND a.project_id = ? AND v.deleted_at IS NULL
      UNION ALL SELECT 'strategy:' || id, name || char(10) || positioning || char(10) || COALESCE(persona, '') || char(10) || target_audience || char(10) || pain_points_json || char(10) || pillars_json || char(10) || topic_mix_json || char(10) || COALESCE(style_notes, '') || char(10) || COALESCE(cadence, '') || char(10) || COALESCE(conversion_path, '') || char(10) || objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ?
    `).bind(item.topic_id, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId).all<{ source_key: string; source_text: string }>();
    for (const row of sourceRows.results) allowed.set(row.source_key, row.source_text.replace(/\s+/g, " ").trim());
    const benchmarkRows = await db.prepare(`
      SELECT library.id AS library_entry_id, analysis.report_json
      FROM project_video_references refs
      INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id AND v.deleted_at IS NULL
      INNER JOIN video_analyses analysis ON analysis.id = (
        SELECT latest.id FROM video_analyses latest
        WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id
        ORDER BY latest.created_at DESC LIMIT 1
      )
      WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark'
    `).bind(organizationId, projectId).all<{ library_entry_id: string; report_json: string }>();
    for (const row of benchmarkRows.results) allowed.set(`benchmark:${row.library_entry_id}`, analysisReportSourceText(row.report_json).replace(/\s+/g, " ").trim());
    const invalidCitation = pack.citations.some((citation) => {
      const source = allowed.get(`${citation.sourceType}:${citation.sourceId}`);
      return !source || !source.includes(citation.quote.replace(/\s+/g, " ").trim());
    });
    if (invalidCitation) return apiError("INVALID_CONTENT_CITATION", "内容包含不属于当前项目或无法逐字定位的引用。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString(); const nextVersion = item.current_version + 1; const versionId = crypto.randomUUID(); const packJson = JSON.stringify(pack);
    const statements = [
      db.prepare("UPDATE content_items SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(nextVersion, user.id, now, contentId, organizationId, projectId, item.current_version),
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, created_by, created_at) SELECT ?, organization_id, project_id, id, ?, 'manual', ?, ?, ?, ?, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(versionId, nextVersion, packJson, pack.fullScript, pack.shortScript, changeSummary || "手动编辑生产包", user.id, now, contentId, organizationId, projectId, nextVersion),
      ...pack.citations.map((citation) => db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, citation.sourceType, citation.sourceId, citation.quote, user.id, now)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.version.created', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ version: nextVersion, mode: "manual" }), now),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("CONTENT_VERSION_CONFLICT", "内容已被其他成员更新，请刷新后重试。", 409);
    return Response.json({ item: { id: contentId, current_version: nextVersion, version_id: versionId, generation_mode: "manual", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
