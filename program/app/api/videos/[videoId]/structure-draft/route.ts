import { z } from "zod";
import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { createProductionScaffold } from "../../../../../lib/content-production";
import { commitContentWorkflowWrite } from "../../../../../lib/content-workflow-write";
import { readRequestIdentity } from "../../../../../lib/request-auth";
import { referenceCreationInputSchema } from "../../../../../lib/structure-creation";
import { studioIdeaGuard } from "../../../../../lib/studio-ideas";
import { confirmStructureDraft, readStructureDraftPreview, StructureDraftError, structureVideoScopeSql } from "../../../../../lib/structure-draft";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ videoId: string }> };
const id = z.string().trim().min(1).max(200);
const scopeSchema = z.object({ organizationId: id, projectId: id, libraryEntryId: id.optional() });
const createSchema = scopeSchema.extend({ requestId: id, referenceCreation: referenceCreationInputSchema });
const respondError = (error: unknown) => error instanceof StructureDraftError ? apiError(error.code, error.message, error.status) : errorResponse(error);

export async function GET(request: Request, context: RouteContext) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  try {
    const parsed = scopeSchema.extend({ analysisId: id.optional() }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return apiError("INVALID_STRUCTURE_SCOPE", "请指定空间和参考分析。", 400);
    const { organizationId, projectId } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问这个空间。", 403);
    const { videoId } = await context.params;
    const preview = await readStructureDraftPreview(getD1(), { ...parsed.data, videoId });
    return Response.json({ ...preview, canWrite: canWriteProjectAccess(access) });
  } catch (error) { return respondError(error); }
}

export async function POST(request: Request, context: RouteContext) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  try {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError("INVALID_STRUCTURE_INPUT", "请确认参考视频、选题和各段要用的材料。", 400);
    const { organizationId, projectId, requestId, referenceCreation, libraryEntryId } = parsed.data;
    const { videoId } = await context.params;
    if (referenceCreation.videoId !== videoId) return apiError("REFERENCE_MISMATCH", "提交的参考视频与当前页面不一致。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能在此空间创建稿件。", 403);
    const db = getD1();
    const user = await ensureUser(identity);
    const preview = await readStructureDraftPreview(db, { organizationId, projectId, videoId, analysisId: referenceCreation.analysisId, libraryEntryId });
    const confirmed = confirmStructureDraft(preview, referenceCreation);
    // The same client key from another user or space can never resolve this receipt.
    const digest = (value: unknown) => sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
    const contentId = await digest(["structure-draft-v1", organizationId, projectId, user.id, requestId]);
    const inputDigest = await digest(referenceCreation);
    const savedResponse = (topicId: string, version: number, created = false) => Response.json({
      contentId, topicId, version, referenceEntryId: preview.referenceEntryId, benchmarkEntryIds: preview.referenceEntryId ? [preview.referenceEntryId] : [],
    }, { status: created ? 201 : 200 });
    const existing = async () => {
      const saved = await db.prepare(`SELECT c.topic_id,c.current_version,c.deleted_at,t.deleted_at AS topic_deleted,
        json_extract(v.pack_json, '$.structureRequestDigest') AS digest FROM content_items c
        JOIN topic_ideas t ON t.id=c.topic_id AND t.project_id=c.project_id AND t.organization_id=c.organization_id
        JOIN content_versions v ON v.content_item_id=c.id AND v.version=1 AND v.project_id=c.project_id AND v.organization_id=c.organization_id
        WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.created_by=?`).bind(contentId, organizationId, projectId, user.id)
        .first<{ topic_id: string; current_version: number; deleted_at: string | null; topic_deleted: string | null; digest: string | null }>();
      if (!saved) return null;
      if (saved.deleted_at || saved.topic_deleted || saved.digest !== inputDigest) return apiError("DRAFT_REQUEST_CONFLICT", "此次提交标识已用于另一份确认内容或已删除的草稿，请重新发起创作。", 409);
      return savedResponse(saved.topic_id, saved.current_version);
    };
    const prior = await existing();
    if (prior) return prior;
    const topicId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = confirmed.topic;
    const idea = referenceCreation.idea;
    const ideaCheck = idea ? studioIdeaGuard({ organizationId, projectId }, idea.kind, idea.id, title) : null;
    const scaffold = createProductionScaffold({ id: topicId, title: title.slice(0, 120) });
    const pack = JSON.stringify({ ...scaffold, referenceCreation, structureRequestDigest: inputDigest });
    const knowledgeIds = JSON.stringify(confirmed.materials.map(material => material.id));
    const citations = [
      { type: "video_analysis", id: preview.analysisId, quote: preview.segments[0].excerpt.slice(0, 80) },
      ...confirmed.materials.map(material => ({ type: "knowledge", id: material.id, quote: material.body.slice(0, 80) })),
    ];
    const saved = await commitContentWorkflowWrite(db, {
      request, authSubject: identity.authSubject, scope: { organizationId, projectId, userId: user.id },
      targetId: contentId, version: now, action: "content.structure_draft_created", targetType: "content_item",
      metadata: { topicId, analysisId: preview.analysisId, topicMode: confirmed.topicMode, hasFocus: Boolean(confirmed.focus) },
      guard: `NOT EXISTS(SELECT 1 FROM content_items WHERE id=?) AND EXISTS(
        SELECT 1 FROM videos v JOIN video_analyses a ON a.video_id=v.id AND a.organization_id=v.organization_id AND a.project_id=v.project_id
        WHERE v.id=? AND v.organization_id=? AND v.deleted_at IS NULL AND a.id=? AND ${structureVideoScopeSql})
        AND NOT EXISTS(SELECT 1 FROM json_each(?) m WHERE NOT EXISTS(
          SELECT 1 FROM knowledge_items k WHERE k.id=json_extract(m.value,'$.id') AND k.current_version=json_extract(m.value,'$.version')
          AND k.organization_id=? AND k.project_id=? AND k.status='confirmed' AND k.deleted_at IS NULL))${ideaCheck ? " AND (" + ideaCheck.guard + ")" : ""}`,
      bindings: [contentId, videoId, organizationId, preview.analysisId, projectId, projectId,
        JSON.stringify(confirmed.materials.map(({ id, version }) => ({ id, version }))), organizationId, projectId, ...(ideaCheck?.bindings ?? [])],
      mutate: (marker, markerId) => [
        db.prepare(`INSERT INTO topic_ideas(id,organization_id,project_id,title,source_type,source_ref,selected_knowledge_ids_json,status,created_by,updated_by,created_at,updated_at)
          SELECT ?,?,?,?,'video_analysis',?,?,'drafting',?,?,?,? WHERE ${marker}`).bind(topicId, organizationId, projectId, title, videoId, knowledgeIds, user.id, user.id, now, now, markerId),
        db.prepare(`INSERT INTO content_items(id,organization_id,project_id,topic_id,title,status,current_version,created_by,updated_by,created_at,updated_at)
          SELECT ?,?,?,?,?,'draft',1,?,?,?,? WHERE ${marker}`).bind(contentId, organizationId, projectId, topicId, title, user.id, user.id, now, now, markerId),
        db.prepare(`INSERT INTO content_versions(id,organization_id,project_id,content_item_id,version,generation_mode,pack_json,full_script,short_script,change_summary,created_by,created_at)
          SELECT ?,?,?,?,1,'scaffold',?,?,?,'已确认参考结构与逐段材料',?,? WHERE ${marker}`).bind(versionId, organizationId, projectId, contentId, pack, scaffold.fullScript, scaffold.shortScript, user.id, now, markerId),
        ...citations.map(c => db.prepare(`INSERT INTO topic_citations(id,organization_id,project_id,topic_id,citation_type,citation_id,quote,created_by,created_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE ${marker}`).bind(crypto.randomUUID(), organizationId, projectId, topicId, c.type, c.id, c.quote, user.id, now, markerId)),
        ...[{ type: "topic", id: topicId, quote: scaffold.citations[0].quote }, ...citations].map(c => db.prepare(`INSERT INTO content_citations(id,organization_id,project_id,content_item_id,content_version_id,citation_type,citation_id,quote,created_by,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${marker}`).bind(crypto.randomUUID(), organizationId, projectId, contentId, versionId, c.type, c.id, c.quote, user.id, now, markerId)),
      ],
    });
    if (!saved) return await existing() ?? apiError("REFERENCE_CHANGED", idea
      ? "所选灵感、参考视频或材料已变化。请重新选择，也可以直接输入选题。"
      : "参考视频或品牌材料已经变化，请刷新后重新确认。", 409);
    return savedResponse(topicId, 1, true);
  } catch (error) { return respondError(error); }
}
