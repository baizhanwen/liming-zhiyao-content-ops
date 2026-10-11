import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { analysisReportSourceText, citationQuoteMatchesSource, saveContentVersionSchema } from "../../../../lib/content-production";
import { AUTHORIZED_KNOWLEDGE_SOURCE_ID } from "../../../../lib/authorized-knowledge";
import { authorizedMethodologyApplicationPromptSource } from "../../../../lib/authorized-methodology-router";
import { buildPublishedCopyProfile, publishedCopyPromptSource, validateHistoricalStyleApplication, type PublishedCopyRecord } from "../../../../lib/published-copy";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { benchmarkRewriteReportSchema, rewriteCharacterCount } from "../../../../lib/single-benchmark-rewrite";
import { incompleteScriptReason } from "../../../../lib/content-writing-intent";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存内容。", 401);
  try {
    const parsed = saveContentVersionSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_CONTENT_VERSION", "生产包结构不完整或字段过长。", 400);
    const { organizationId, projectId, pack, changeSummary } = parsed.data;
    const incomplete = incompleteScriptReason(pack);
    if (incomplete) return apiError("INCOMPLETE_CONTENT_SCRIPT", incomplete, 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能修改内容。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare("SELECT id, topic_id, current_version FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL AND status NOT IN ('published', 'reviewed', 'archived')").bind(contentId, organizationId, projectId).first<{ id: string; topic_id: string; current_version: number }>();
    if (!item) return apiError("CONTENT_NOT_EDITABLE", "内容不存在、已归档或当前状态不可编辑。", 409);
    const previousVersion = await db.prepare("SELECT pack_json FROM content_versions WHERE content_item_id = ? AND organization_id = ? AND project_id = ? AND version = ?")
      .bind(contentId, organizationId, projectId, item.current_version).first<{ pack_json: string }>();
    let previousRewrite: ReturnType<typeof benchmarkRewriteReportSchema.parse> | undefined;
    try {
      const parsedReport = benchmarkRewriteReportSchema.safeParse(JSON.parse(previousVersion?.pack_json || "{}").benchmarkRewrite);
      if (parsedReport.success) previousRewrite = parsedReport.data;
    } catch { /* Legacy packs have no template snapshot. */ }
    const allowed = new Map<string, string>();
    const sourceRows = await db.prepare(`
      SELECT 'topic:' || id AS source_key, '本次创作选题标题：' || title || char(10) || COALESCE(angle, '') || char(10) || COALESCE(pillar, '') || char(10) || COALESCE(audience, '') || char(10) || COALESCE(objective, '') || char(10) || COALESCE(hook, '') || char(10) || COALESCE(rationale, '') AS source_text FROM topic_ideas WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL
      UNION ALL SELECT 'knowledge:' || k.id, v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL
      UNION ALL SELECT 'video_analysis:' || a.id, a.report_json FROM video_analyses a INNER JOIN videos v ON v.id = a.video_id AND v.organization_id = a.organization_id AND v.project_id = a.project_id WHERE a.organization_id = ? AND a.project_id = ? AND v.deleted_at IS NULL
      UNION ALL SELECT 'strategy:' || id, name || char(10) || positioning || char(10) || COALESCE(persona, '') || char(10) || target_audience || char(10) || pain_points_json || char(10) || pillars_json || char(10) || topic_mix_json || char(10) || COALESCE(style_notes, '') || char(10) || COALESCE(cadence, '') || char(10) || COALESCE(conversion_path, '') || char(10) || objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ?
      UNION ALL SELECT 'memory:' || id, content FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND status = 'confirmed' AND (expires_at IS NULL OR expires_at > datetime('now'))
      UNION ALL SELECT 'video_atom:' || a.id, a.content FROM video_knowledge_atoms a INNER JOIN project_video_references refs ON refs.library_entry_id = a.library_entry_id AND refs.organization_id = a.organization_id AND refs.project_id = ? AND refs.status = 'active' WHERE a.organization_id = ? AND a.status = 'active' AND (refs.purpose = 'analysis' OR refs.purpose = 'benchmark')
      UNION ALL SELECT 'inspiration:' || id, core_insight || char(10) || evidence_json FROM project_inspiration_cards WHERE organization_id = ? AND project_id = ? AND status = 'confirmed' AND (expires_at IS NULL OR expires_at > datetime('now'))    `).bind(item.topic_id, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, organizationId, projectId, projectId, organizationId, organizationId, projectId).all<{ source_key: string; source_text: string }>();
    for (const row of sourceRows.results) allowed.set(row.source_key, row.source_text);
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
      WHERE refs.organization_id = ? AND refs.project_id = ? AND refs.purpose = 'benchmark' AND refs.status = 'active'
    `).bind(organizationId, projectId).all<{ library_entry_id: string; report_json: string }>();
    for (const row of benchmarkRows.results) allowed.set(`benchmark:${row.library_entry_id}`, analysisReportSourceText(row.report_json));
    if (previousRewrite && allowed.has(`benchmark:${previousRewrite.sourceId}`)) {
      allowed.set(`benchmark:${previousRewrite.sourceId}`, `${previousRewrite.sourceScript}\n${allowed.get(`benchmark:${previousRewrite.sourceId}`)}`);
    }
    const historicalCopyIds = pack.citations.filter((citation) => citation.sourceType === "historical_copy").map((citation) => citation.sourceId);
    let historicalRowsForValidation: PublishedCopyRecord[] = [];
    if (historicalCopyIds.length) {
      const historicalRows = await db.prepare(`SELECT pc.id, pc.title, pc.body, pc.platform, pc.content_format, pc.source_type, pc.published_at, pc.external_url,
        pc.character_count, pc.paragraph_count, pc.monetization_types_json, pc.monetization_detail, pc.analysis_json,
        CASE WHEN latest.id IS NULL THEN pc.performance_json ELSE json_set(
          COALESCE(NULLIF(pc.performance_json, ''), '{}'),
          '$.views', latest.views, '$.likes', latest.likes, '$.saves', latest.saves, '$.leads', latest.leads
        ) END AS performance_json,
        pc.created_at, pc.updated_at FROM published_copy_records pc
        LEFT JOIN publication_metric_snapshots latest ON latest.id = (
          SELECT snapshot.id FROM publication_metric_snapshots snapshot
          WHERE snapshot.organization_id = pc.organization_id AND snapshot.project_id = pc.project_id AND snapshot.publication_id = pc.publication_id
          ORDER BY snapshot.observed_at DESC, snapshot.created_at DESC LIMIT 1
        )
        WHERE pc.organization_id = ? AND pc.project_id = ? AND pc.deleted_at IS NULL
        ORDER BY COALESCE(pc.published_at, pc.created_at) DESC LIMIT 200`).bind(organizationId, projectId).all<PublishedCopyRecord>();
      historicalRowsForValidation = historicalRows.results;
      const citedIds = new Set(historicalCopyIds);
      for (const row of historicalRows.results) if (citedIds.has(row.id)) allowed.set(`historical_copy:${row.id}`, publishedCopyPromptSource(row));
    }
    const methodKnowledgeIds = pack.citations.filter((citation) => citation.sourceType === "method_knowledge").map((citation) => citation.sourceId);
    const atomicMethodKnowledgeIds = methodKnowledgeIds.filter((id) => !id.startsWith("methodology."));
    if (atomicMethodKnowledgeIds.length) {
      const placeholders = atomicMethodKnowledgeIds.map(() => "?").join(", ");
      const methodRows = await db.prepare(`SELECT id, knowledge, original FROM authorized_knowledge_atoms WHERE source_id = ? AND id IN (${placeholders})`).bind(AUTHORIZED_KNOWLEDGE_SOURCE_ID, ...atomicMethodKnowledgeIds).all<{ id: string; knowledge: string; original: string }>();
      for (const row of methodRows.results) allowed.set(`method_knowledge:${row.id}`, `${row.knowledge}\n${row.original}`);
    }
    const methodologyApplication = pack.qualityReview?.methodologyApplication;
    if (methodologyApplication && methodKnowledgeIds.includes(methodologyApplication.planId)) {
      const methodologySource = authorizedMethodologyApplicationPromptSource(methodologyApplication);
      if (methodologySource) allowed.set(`method_knowledge:${methodologyApplication.planId}`, methodologySource);
    }
    const invalidCitation = pack.citations.some((citation) => {
      const source = allowed.get(`${citation.sourceType}:${citation.sourceId}`);
      return !source || !citationQuoteMatchesSource(source, citation.quote);
    });
    if (invalidCitation) return apiError("INVALID_CONTENT_CITATION", "内容包含不属于当前项目或无法逐字定位的引用。", 409);
    const validatedPack = historicalCopyIds.length
      ? { ...pack, historicalStyleApplication: validateHistoricalStyleApplication(pack.fullScript, buildPublishedCopyProfile(historicalRowsForValidation), historicalRowsForValidation.filter((row) => historicalCopyIds.includes(row.id)), historicalCopyIds) }
      : { ...pack, historicalStyleApplication: undefined };
    validatedPack.benchmarkRewriteSegments = undefined;
    // Preserve only server-saved evidence; never accept a client-authored alignment report.
    validatedPack.benchmarkRewrite = previousRewrite ? { ...previousRewrite,
      status: pack.fullScript === previousRewrite.generatedScript ? "aligned" : "edited",
      generatedCharacters: rewriteCharacterCount(pack.fullScript),
    } : undefined;
    const user = await ensureUser(identity); const now = new Date().toISOString(); const nextVersion = item.current_version + 1; const versionId = crypto.randomUUID(); const packJson = JSON.stringify(validatedPack);
    const statements = [
      db.prepare("UPDATE content_items SET current_version = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(nextVersion, user.id, now, contentId, organizationId, projectId, item.current_version),
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, created_by, created_at) SELECT ?, organization_id, project_id, id, ?, 'manual', ?, ?, ?, ?, ?, ? FROM content_items WHERE id = ? AND organization_id = ? AND project_id = ? AND current_version = ?").bind(versionId, nextVersion, packJson, validatedPack.fullScript, validatedPack.shortScript, changeSummary || "手动编辑生产包", user.id, now, contentId, organizationId, projectId, nextVersion),
      ...pack.citations.map((citation) => db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, citation.sourceType, citation.sourceId, citation.quote, user.id, now)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.version.created', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ version: nextVersion, mode: "manual" }), now),
    ];
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("CONTENT_VERSION_CONFLICT", "内容已被其他成员更新，请刷新后重试。", 409);
    return Response.json({ item: { id: contentId, current_version: nextVersion, version_id: versionId, generation_mode: "manual", pack_json: packJson, full_script: validatedPack.fullScript, short_script: validatedPack.shortScript, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
