import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { createProductionScaffold, rewriteDraftPackSchema } from "../../../../../lib/content-production";
import { commitContentWorkflowWrite } from "../../../../../lib/content-workflow-write";
import { readRequestIdentity } from "../../../../../lib/request-auth";

import { rewriteBrandGuard } from "../../../../../lib/script-rewrite-brand";
import { parseRewriteSnapshot } from "../../../../../lib/script-rewrite-options";

type SourceVersion = { title: string; text: string; version: number; variant: string; source_hash: string; adaptation_json: string | null };
type DraftRow = { id: string; deleted_at: string | null };

function scopedId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

export async function POST(request: Request, { params }: { params: Promise<{ rewriteId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再将改写转为稿件。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = scopedId(payload.organizationId);
    const projectId = scopedId(payload.projectId);
    const versionId = scopedId(payload.versionId);
    const { rewriteId } = await params;
    if (!organizationId || !projectId || !rewriteId || !versionId) return apiError("REWRITE_VERSION_REQUIRED", "请选择当前企业空间中的一个改写版本。", 400);

    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建稿件。", 403);
    const db = getD1();
    const sourceQuery = `FROM script_rewrite_versions v
      INNER JOIN script_rewrite_workspaces w ON w.id = v.workspace_id AND w.organization_id = v.organization_id AND w.project_id = v.project_id
      WHERE w.id = ? AND v.id = ? AND w.organization_id = ? AND w.project_id = ? AND w.status = 'active' AND v.variant <> 'source'`;
    const sourceBindings = [rewriteId, versionId, organizationId, projectId];
    const source = await db.prepare(`SELECT w.title, w.source_hash, v.text, v.version, v.variant, v.adaptation_json ${sourceQuery}`).bind(...sourceBindings).first<SourceVersion>();
    if (!source) return apiError("REWRITE_VERSION_NOT_FOUND", "改写版本不可用，请刷新并选择已保存的改写结果。", 404);

    const existingQuery = `FROM topic_ideas t
      INNER JOIN content_items c ON c.topic_id = t.id AND c.organization_id = t.organization_id AND c.project_id = t.project_id
      WHERE t.organization_id = ? AND t.project_id = ? AND t.source_type = 'script_rewrite' AND t.source_ref = ?`;
    const existingBindings = [organizationId, projectId, versionId];
    const findExisting = () => db.prepare(`SELECT c.id, c.deleted_at ${existingQuery}`).bind(...existingBindings).first<DraftRow>();
    const existingResponse = (draft: DraftRow) => draft.deleted_at
      ? apiError("REWRITE_DRAFT_ARCHIVED", "该改写版本已有保留的历史稿件。请先保存一个新的改写版本，再创建稿件。", 409)
      : Response.json({ contentId: draft.id, reused: true });
    const existing = await findExisting();
    if (existing) return existingResponse(existing);

    const snapshot = parseRewriteSnapshot(source.adaptation_json);
    const brandGuard = snapshot?.mode === "current_brand" ? rewriteBrandGuard({ organizationId, projectId }, snapshot.brandStamp ?? "") : null;
    if (brandGuard && !(await db.prepare(`SELECT 1 AS ok WHERE ${brandGuard.sql}`).bind(...brandGuard.bindings).first())) {
      return apiError("REWRITE_BRAND_CHANGED", "这版采用的品牌资料已更新，请用当前资料重新生成后再转为稿件。历史版本仍可查看。", 409);
    }
    const user = await ensureUser(identity);
    const now = new Date().toISOString();
    const topicId = crypto.randomUUID();
    const contentId = crypto.randomUUID();
    const draftVersionId = crypto.randomUUID();
    const title = source.title;
    const fullScript = source.text.trim();
    const shortScript = fullScript.slice(0, 6_000).trimEnd();
    const opening = fullScript.split(/\n/u, 1)[0].slice(0, 200);
    const scaffold = createProductionScaffold({ id: topicId, title: title.slice(0, 120) });
    const parsed = rewriteDraftPackSchema.safeParse({
      ...scaffold,
      fullScript,
      shortScript,
      storyboard: [{ ...scaffold.storyboard[0], script: opening }],
    });
    if (!parsed.success) return apiError("INVALID_REWRITE_DRAFT", "该版本的文本超出稿件支持范围，请保存一个符合长度的改写版本。", 409);

    const origin = { sourceType: "script_rewrite", sourceId: versionId, workspaceId: rewriteId, version: source.version, variant: source.variant, sourceHash: source.source_hash,
      ...(snapshot ? { adaptation: { mode: snapshot.mode, targetName: snapshot.targetName, goal: snapshot.goal, audience: snapshot.audience, scenario: snapshot.scenario,
        sources: snapshot.sources.map(({ itemId, versionId, version }) => ({ itemId, versionId, version })), mappings: snapshot.mappings,
        inheritedFromVersionId: snapshot.inheritedFromVersionId } } : {}) };
    const manifest = JSON.stringify([origin]);
    const changeSummary = `从口播改写 v${source.version} 转为稿件`;
    const saved = await commitContentWorkflowWrite(db, {
      request,
      authSubject: identity.authSubject,
      scope: { organizationId, projectId, userId: user.id },
      targetId: contentId,
      version: now,
      action: "content.created",
      targetType: "content_item",
      metadata: { topicId, version: 1, origin },
      guard: `EXISTS(SELECT 1 ${sourceQuery} AND v.text = ? AND w.title = ? AND w.source_hash = ?) AND NOT EXISTS(SELECT 1 ${existingQuery}) ${brandGuard ? `AND (${brandGuard.sql})` : ""}`,
      bindings: [...sourceBindings, source.text, title, source.source_hash, ...existingBindings, ...(brandGuard?.bindings ?? [])],
      mutate: (marker, markerId) => [
        // The existing publishing workflow requires a topic to own every content item.
        db.prepare(`INSERT INTO topic_ideas (id, organization_id, project_id, title, source_type, source_ref, source_manifest_json, status, created_by, updated_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, 'script_rewrite', ?, ?, 'drafting', ?, ?, ?, ? WHERE ${marker}`).bind(topicId, organizationId, projectId, title, versionId, manifest, user.id, user.id, now, now, markerId),
        db.prepare(`INSERT INTO content_items (id, organization_id, project_id, topic_id, title, status, current_version, created_by, updated_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ? WHERE ${marker}`).bind(contentId, organizationId, projectId, topicId, title, user.id, user.id, now, now, markerId),
        db.prepare(`INSERT INTO content_versions (id, organization_id, project_id, content_item_id, version, generation_mode, pack_json, full_script, short_script, change_summary, source_manifest_json, created_by, created_at)
          SELECT ?, ?, ?, ?, 1, 'manual', ?, ?, ?, ?, ?, ?, ? WHERE ${marker}`).bind(draftVersionId, organizationId, projectId, contentId, JSON.stringify(parsed.data), fullScript, shortScript, changeSummary, manifest, user.id, now, markerId),
        db.prepare(`INSERT INTO content_citations (id, organization_id, project_id, content_item_id, content_version_id, citation_type, citation_id, quote, created_by, created_at)
          SELECT ?, ?, ?, ?, ?, 'topic', ?, ?, ?, ? WHERE ${marker}`).bind(crypto.randomUUID(), organizationId, projectId, contentId, draftVersionId, topicId, scaffold.citations[0].quote, user.id, now, markerId),
      ],
    });
    if (!saved) {
      const current = await findExisting();
      if (current) return existingResponse(current);
      return apiError("REWRITE_DRAFT_SOURCE_CHANGED", "改写版本已变化，请刷新后重新选择。", 409);
    }
    return Response.json({ contentId, reused: false }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
