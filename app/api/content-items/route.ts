import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { createContentItemSchema, createProductionScaffold } from "../../../lib/content-production";
import { readRequestIdentity } from "../../../lib/request-auth";

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
    const [items, citations] = await Promise.all([
      db.prepare(`
        SELECT c.id, c.topic_id, c.title, c.status, c.current_version, c.assignee_user_id, c.due_at, c.updated_at,
          v.id AS version_id, v.generation_mode, v.pack_json, v.full_script, v.short_script, v.change_summary, v.prompt_version, v.model_call_id, v.created_at AS version_created_at
        FROM content_items c
        INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id
        WHERE c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL
        ORDER BY c.updated_at DESC LIMIT 200
      `).bind(organizationId, projectId).all(),
      db.prepare("SELECT id, content_item_id, content_version_id, citation_type, citation_id, quote FROM content_citations WHERE organization_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1000").bind(organizationId, projectId).all(),
    ]);
    return Response.json({ items: items.results, citations: citations.results, canWrite: canWriteProjectAccess(access) });
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
    const topic = await db.prepare("SELECT id, title, angle, hook, objective FROM topic_ideas WHERE id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL AND status != 'archived'").bind(topicId, organizationId, projectId).first<{ id: string; title: string; angle: string | null; hook: string | null; objective: string | null }>();
    if (!topic) return apiError("TOPIC_NOT_FOUND", "选题不存在或不属于当前项目。", 404);
    const existing = await db.prepare("SELECT id FROM content_items WHERE topic_id = ? AND organization_id = ? AND project_id = ? AND deleted_at IS NULL").bind(topicId, organizationId, projectId).first<{ id: string }>();
    if (existing) return apiError("CONTENT_ALREADY_EXISTS", "该选题已经进入内容生产。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const contentId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const pack = createProductionScaffold(topic); const packJson = JSON.stringify(pack);
    await db.batch([
      db.prepare("INSERT INTO content_items (id, organization_id, project_id, topic_id, title, status, current_version, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)").bind(contentId, organizationId, projectId, topicId, topic.title, user.id, user.id, now, now),
      db.prepare("INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, 1, 'scaffold', ?, ?, ?, '从选题创建结构草稿', ?, ?)").bind(versionId, organizationId, projectId, contentId, packJson, pack.fullScript, pack.shortScript, user.id, now),
      db.prepare("INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'topic', ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, topicId, topic.title, user.id, now),
      db.prepare("UPDATE topic_ideas SET status = 'drafting', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(user.id, now, topicId, organizationId, projectId),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.created', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ topicId, version: 1 }), now),
    ]);
    return Response.json({ item: { id: contentId, topic_id: topicId, title: topic.title, status: "draft", current_version: 1, version_id: versionId, generation_mode: "scaffold", pack_json: packJson, full_script: pack.fullScript, short_script: pack.shortScript, updated_at: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
