import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { buildScriptUnits, SCRIPT_REWRITE_MAX_CHARACTERS } from "../../../../lib/script-rewrite";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { rewriteVersionAudit, rewriteVersionInsert } from "../../../../lib/script-rewrite-write";

import { readRewriteBrandContext } from "../../../../lib/script-rewrite-brand";
import { parseRewriteSnapshot, type RewriteAdaptationSnapshot } from "../../../../lib/script-rewrite-options";

export const dynamic = "force-dynamic";

const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const parseJson = (value: unknown, fallback: unknown) => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
};

function publicVersion(row: Record<string, unknown>) {
  return {
    adaptation: parseRewriteSnapshot(row.adaptation_json as string | null), id: row.id, version: row.version, variant: row.variant, parentVersionId: row.parent_version_id, runId: row.run_id,
    text: row.text, paragraphs: parseJson(row.paragraphs_json, []), sourceMapping: parseJson(row.source_mapping_json, []), outline: parseJson(row.outline_json, []), validation: parseJson(row.validation_json, {}),
    modelProvider: row.model_provider, modelName: row.model_name, promptVersion: row.prompt_version, modelCallId: row.model_call_id, changeSummary: row.change_summary, createdAt: row.created_at, draftId: row.draft_id,
  };
}

function publicRun(row: Record<string, unknown>) {
  const validation = parseJson(row.validation_json, {}) as { modelUsage?: { unknownRequestCount?: unknown } } | null;
  const unknown = validation?.modelUsage?.unknownRequestCount;
  return {
    adaptation: parseRewriteSnapshot(row.adaptation_json as string | null), id: row.id, variant: row.variant, status: row.status, sourceVersionId: row.source_version_id, resultVersionId: row.result_version_id, retryOfRunId: row.retry_of_run_id,
    estimatedCallCount: row.estimated_call_count, estimatedInputTokens: row.estimated_input_tokens, maximumOutputTokens: row.maximum_output_tokens,
    actualInputTokens: row.actual_input_tokens, actualOutputTokens: row.actual_output_tokens, actualTotalTokens: row.actual_total_tokens,
    unknownRequestCount: typeof unknown === "number" && Number.isSafeInteger(unknown) && unknown >= 0 ? unknown : null,
    modelCallId: row.model_call_id, promptVersion: row.prompt_version, validation: parseJson(row.validation_json, {}), errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, completedAt: row.completed_at,
  };
}

async function readWorkspace(organizationId: string, projectId: string, rewriteId: string) {
  return getD1().prepare(`SELECT id, title, source_type, source_video_id, source_transcript_id, source_transcript_version, source_analysis_id, source_label, source_text, source_hash, source_character_count, status, created_at, updated_at FROM script_rewrite_workspaces WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'`).bind(rewriteId, organizationId, projectId).first<Record<string, unknown>>();
}

export async function GET(request: Request, context: { params: Promise<{ rewriteId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看口播改写。", 401);
  const url = new URL(request.url); const organizationId = clean(url.searchParams.get("organizationId"), 100); const projectId = clean(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的口播改写。", 403);
    const { rewriteId } = await context.params; const workspace = await readWorkspace(organizationId, projectId, rewriteId);
    if (!workspace) return apiError("REWRITE_NOT_FOUND", "口播改写工作区不存在。", 404);
    const db = getD1();
    const [versions, runs, brandKnowledge] = await Promise.all([
      db.prepare(`SELECT v.adaptation_json, v.id, v.version, v.variant, v.parent_version_id, v.run_id, v.text, v.paragraphs_json, v.source_mapping_json, v.outline_json, v.validation_json, v.model_provider, v.model_name, v.prompt_version, v.model_call_id, v.change_summary, v.created_at, c.id AS draft_id
        FROM script_rewrite_versions v
        LEFT JOIN topic_ideas t ON t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.source_type = 'script_rewrite' AND t.source_ref = v.id
        LEFT JOIN content_items c ON c.topic_id = t.id AND c.organization_id = t.organization_id AND c.project_id = t.project_id AND c.deleted_at IS NULL
        WHERE v.organization_id = ? AND v.project_id = ? AND v.workspace_id = ? ORDER BY v.version DESC`).bind(organizationId, projectId, rewriteId).all(),
      db.prepare(`SELECT adaptation_json, id, variant, status, source_version_id, result_version_id, retry_of_run_id, estimated_call_count, estimated_input_tokens, maximum_output_tokens, actual_input_tokens, actual_output_tokens, actual_total_tokens, model_call_id, prompt_version, validation_json, error_code, error_message, created_at, completed_at FROM script_rewrite_runs WHERE organization_id = ? AND project_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(organizationId, projectId, rewriteId).all(),
      readRewriteBrandContext(db, { organizationId, projectId }, String(workspace.source_text)),
    ]);
    return Response.json({
      brandKnowledge, workspace: {
        id: workspace.id, title: workspace.title, sourceType: workspace.source_type, sourceVideoId: workspace.source_video_id, sourceTranscriptId: workspace.source_transcript_id, sourceTranscriptVersion: workspace.source_transcript_version, sourceAnalysisId: workspace.source_analysis_id,
        sourceLabel: workspace.source_label, sourceText: workspace.source_text, sourceHash: workspace.source_hash, sourceCharacters: workspace.source_character_count, createdAt: workspace.created_at, updatedAt: workspace.updated_at,
      },
      versions: versions.results.map((item) => publicVersion(item as Record<string, unknown>)),
      runs: runs.results.map((item) => publicRun(item as Record<string, unknown>)),
      canWrite: canWriteProjectAccess(access),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ rewriteId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再保存人工版本。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>; const organizationId = clean(payload.organizationId, 100); const projectId = clean(payload.projectId, 100);
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能保存人工改写版本。", 403);
    const { rewriteId } = await context.params; const workspace = await readWorkspace(organizationId, projectId, rewriteId);
    if (!workspace) return apiError("REWRITE_NOT_FOUND", "口播改写工作区不存在。", 404);
    const body = clean(payload.text, SCRIPT_REWRITE_MAX_CHARACTERS + 1);
    if (body.length < 20) return apiError("REWRITE_TEXT_TOO_SHORT", "人工版本至少需要 20 个字符。", 400);
    if (body.length > SCRIPT_REWRITE_MAX_CHARACTERS) return apiError("REWRITE_TEXT_TOO_LONG", `人工版本超过 ${SCRIPT_REWRITE_MAX_CHARACTERS.toLocaleString("zh-CN")} 字符上限。`, 413);
    const parentVersionId = clean(payload.parentVersionId, 100);
    const db = getD1();
    let adaptation: RewriteAdaptationSnapshot | null = null;
    if (parentVersionId) {
      const parent = await db.prepare("SELECT id, adaptation_json FROM script_rewrite_versions WHERE id = ? AND organization_id = ? AND project_id = ? AND workspace_id = ?").bind(parentVersionId, organizationId, projectId, rewriteId).first<{ id: string; adaptation_json: string | null }>();
      if (!parent) return apiError("REWRITE_PARENT_VERSION_NOT_FOUND", "要编辑的来源版本不存在。", 404);
      const inherited = parseRewriteSnapshot(parent.adaptation_json);
      if (inherited) adaptation = { ...inherited, inheritedFromVersionId: parent.id, qualityNotes: [] };
    }
    const versionId = crypto.randomUUID(); const user = await ensureUser(identity); const now = new Date().toISOString(); const units = buildScriptUnits(body, SCRIPT_REWRITE_MAX_CHARACTERS);
    const scope = { organizationId, projectId, workspaceId: rewriteId, userId: user.id };
    const currentIdentity = await readRequestIdentity(request);
    if (!currentIdentity || currentIdentity.authSubject !== identity.authSubject) return apiError("REWRITE_ACCESS_CHANGED", "登录状态已改变，请重新登录后保存；编辑内容仍保留在输入框中。", 403);
    const saved = await db.batch([
      rewriteVersionInsert(db, { ...scope, id: versionId, variant: "manual", adaptation, parentVersionId: parentVersionId || null, text: body, paragraphs: units.map(item => item.text), sourceMapping: units.map(item => item.paragraphId), changeSummary: clean(payload.changeSummary, 500) || "人工编辑保存", now }),
      db.prepare("UPDATE script_rewrite_workspaces SET updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM script_rewrite_versions WHERE id = ?)").bind(user.id, now, rewriteId, organizationId, projectId, versionId),
      rewriteVersionAudit(db, { ...scope, id: crypto.randomUUID(), versionId, action: "script_rewrite.manual_version_saved", metadata: { workspaceId: rewriteId, parentVersionId: parentVersionId || null }, now }),
      db.prepare("SELECT version FROM script_rewrite_versions WHERE id = ?").bind(versionId),
    ]);
    if (!saved[0].meta.changes) return apiError("REWRITE_ACCESS_CHANGED", "项目权限或工作区状态已改变，未保存新版本；请刷新确认权限，编辑内容仍保留在输入框中。", 403);
    const version = (saved[3].results[0] as { version: number }).version;
    return Response.json({ version: { id: versionId, version, variant: "manual", adaptation, text: body, paragraphs: units.map((item) => item.text), parentVersionId: parentVersionId || null, createdAt: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
