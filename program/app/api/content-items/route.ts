import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { createContentItemSchema, createProductionScaffold } from "../../../lib/content-production";
import { readRequestIdentity } from "../../../lib/request-auth";

import { topicKnowledgeSelection } from "../../../lib/topic-knowledge-selection";
import { readCoreContentStrategy } from "../../../lib/content-strategy-policy";
import { commitContentWorkflowWrite } from "../../../lib/content-workflow-write";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问内容生产。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的内容生产。", 403);
    const db = getD1();
    const [items, citations, coreStrategy] = await Promise.all([
      db.prepare(`
        SELECT c.id, c.topic_id, c.title, c.status, c.current_version, c.assignee_user_id, c.due_at, c.updated_at,
          v.id AS version_id, v.generation_mode, v.pack_json, v.full_script, v.short_script, v.change_summary, v.prompt_version, v.model_call_id, v.created_at AS version_created_at,
          t.source_type AS topic_source_type, t.source_ref AS topic_source_ref, t.selected_knowledge_ids_json,
          generation.status AS latest_generation_status, generation.error_message AS latest_generation_error,
          (SELECT COUNT(*) FROM content_citations cc WHERE cc.organization_id = c.organization_id AND cc.project_id = c.project_id AND cc.content_item_id = c.id AND cc.content_version_id = v.id) AS citation_count
        FROM content_items c
        INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id
        INNER JOIN topic_ideas t ON t.id = c.topic_id AND t.organization_id = c.organization_id AND t.project_id = c.project_id
        LEFT JOIN model_calls generation ON generation.id = (
          SELECT m.id FROM model_calls m WHERE m.organization_id = c.organization_id AND m.project_id = c.project_id
            AND m.topic_id = c.topic_id AND m.task_type = 'content_draft' ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        )
        WHERE c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL
        ORDER BY c.updated_at DESC LIMIT 200
      `).bind(organizationId, projectId).all(),
      db.prepare("SELECT id, content_item_id, content_version_id, citation_type, citation_id, quote FROM content_citations WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1000").bind(organizationId, projectId).all(),
      readCoreContentStrategy(db, { organizationId, projectId }),
    ]);
    return Response.json({ items: items.results, citations: citations.results, coreStrategy, canWrite: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建内容。", 401);
  try {
    const parsed = createContentItemSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_CONTENT_INPUT", "内容生产参数无效。", 400);
    const { organizationId, projectId, topicId } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建内容。", 403);
    const db = getD1();
    const topic = await db.prepare("SELECT id, title, angle, hook, objective, source_type, source_ref, selected_knowledge_ids_json, status, updated_at FROM topic_ideas WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL AND status != 'archived'").bind(topicId, organizationId, projectId).first<{ id: string; title: string; angle: string | null; hook: string | null; objective: string | null; source_type: string; source_ref: string | null; selected_knowledge_ids_json: string; status: string; updated_at: string }>();
    if (!topic) return apiError("TOPIC_NOT_FOUND", "选题不存在或不属于当前项目。", 404);
    const selectedKnowledgeIds = topicKnowledgeSelection(topic.selected_knowledge_ids_json);
    const inheritedCitations = await db.prepare("SELECT id, citation_type, citation_id, quote FROM topic_citations WHERE organization_id = ? AND project_id = ? AND topic_id = ? AND (citation_type = 'video_analysis' OR (citation_type = 'knowledge' AND citation_id IN (SELECT value FROM json_each(?)))) ORDER BY created_at ASC").bind(organizationId, projectId, topicId, JSON.stringify(selectedKnowledgeIds)).all<{ id: string; citation_type: string; citation_id: string; quote: string | null }>();
    // The unique topic index includes retained history. Never try to overwrite it.
    const existingContent = () => db.prepare("SELECT id, deleted_at FROM content_items WHERE topic_id = ?").bind(topicId).first<{ id: string; deleted_at: string | null }>();
    const existing = await existingContent();
    if (existing) return apiError("CONTENT_ALREADY_EXISTS", existing.deleted_at ? "该选题已有保留的历史内容。如需另建内容，请创建新选题；历史版本不会覆盖。" : "该选题已经进入内容生产，请刷新选题列表后继续生产。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const contentId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const pack = createProductionScaffold(topic); const packJson = JSON.stringify(pack);
    const saved = await commitContentWorkflowWrite(db, {
      request, authSubject: identity.authSubject, scope: { organizationId, projectId, userId: user.id },
      targetId: contentId, version: now, action: "content.created", targetType: "content_item", metadata: { topicId, version: 1 },
      guard: `EXISTS(SELECT 1 FROM topic_ideas t WHERE t.id=? AND t.organization_id=? AND t.project_id=?
        AND t.deleted_at IS NULL AND t.status=? AND t.updated_at=? AND t.title=? AND t.angle IS ? AND t.hook IS ?
        AND t.objective IS ? AND t.source_type=? AND t.source_ref IS ? AND t.selected_knowledge_ids_json=?)
        AND NOT EXISTS(SELECT 1 FROM content_items WHERE topic_id=?)
        AND (SELECT COUNT(*) FROM topic_citations WHERE organization_id=? AND project_id=? AND topic_id=?
          AND (citation_type='video_analysis' OR (citation_type='knowledge' AND citation_id IN (SELECT value FROM json_each(?)))))=?
        AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM topic_citations tc
          WHERE tc.id=json_extract(expected.value,'$.id') AND tc.organization_id=? AND tc.project_id=? AND tc.topic_id=?
          AND tc.citation_type=json_extract(expected.value,'$.citation_type') AND tc.citation_id=json_extract(expected.value,'$.citation_id')
          AND tc.quote IS json_extract(expected.value,'$.quote')))`,
      bindings: [topicId, organizationId, projectId, topic.status, topic.updated_at, topic.title, topic.angle, topic.hook, topic.objective, topic.source_type, topic.source_ref, topic.selected_knowledge_ids_json,
        topicId, organizationId, projectId, topicId, JSON.stringify(selectedKnowledgeIds), inheritedCitations.results.length,
        JSON.stringify(inheritedCitations.results), organizationId, projectId, topicId],
      mutate: (marker, markerId) => [
        db.prepare(`INSERT INTO content_items (id, organization_id, project_id, topic_id, title, status, current_version, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ? WHERE ${marker}`).bind(contentId, organizationId, projectId, topicId, topic.title, user.id, user.id, now, now, markerId),
        db.prepare(`INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, created_by, created_at) SELECT ?, ?, ?, ?, 1, 'scaffold', ?, ?, ?, '从选题创建结构草稿', ?, ? WHERE ${marker}`).bind(versionId, organizationId, projectId, contentId, packJson, pack.fullScript, pack.shortScript, user.id, now, markerId),
        db.prepare(`INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) SELECT ?, ?, ?, ?, ?, 'topic', ?, ?, ?, ? WHERE ${marker}`).bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, topicId, pack.citations[0].quote, user.id, now, markerId),
        ...inheritedCitations.results.map(citation => db.prepare(`INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${marker}`).bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, citation.citation_type, citation.citation_id, citation.quote, user.id, now, markerId)),
        db.prepare(`UPDATE topic_ideas SET status = 'drafting', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND ${marker}`).bind(user.id, now, topicId, organizationId, projectId, markerId),
      ],
    });
    if (!saved) {
      if (await existingContent()) return apiError("CONTENT_ALREADY_EXISTS", "该选题已经进入内容生产，请刷新选题列表后继续生产。", 409);
      return apiError("TOPIC_SOURCE_CHANGED", "选题或引用已改变，本次未创建内容。请刷新选题列表后核对。", 409);
    }
    return Response.json({ item: { id: contentId, topic_id: topicId, title: topic.title, status: "draft", current_version: 1, version_id: versionId, generation_mode: "scaffold", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, selected_knowledge_ids_json: JSON.stringify(selectedKnowledgeIds), topic_source_type: topic.source_type, topic_source_ref: topic.source_ref, citation_count: inheritedCitations.results.length + 1, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
