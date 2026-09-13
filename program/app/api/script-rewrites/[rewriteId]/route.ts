import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { buildScriptUnits, SCRIPT_REWRITE_MAX_CHARACTERS } from "../../../../lib/script-rewrite";
import { readRequestIdentity } from "../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const parseJson = (value: unknown, fallback: unknown) => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
};

function publicVersion(row: Record<string, unknown>) {
  return {
    id: row.id, version: row.version, variant: row.variant, parentVersionId: row.parent_version_id, runId: row.run_id,
    text: row.text, paragraphs: parseJson(row.paragraphs_json, []), sourceMapping: parseJson(row.source_mapping_json, []), outline: parseJson(row.outline_json, []), validation: parseJson(row.validation_json, {}),
    modelProvider: row.model_provider, modelName: row.model_name, promptVersion: row.prompt_version, modelCallId: row.model_call_id, changeSummary: row.change_summary, createdAt: row.created_at,
  };
}

function publicRun(row: Record<string, unknown>) {
  return {
    id: row.id, variant: row.variant, status: row.status, sourceVersionId: row.source_version_id, resultVersionId: row.result_version_id, retryOfRunId: row.retry_of_run_id,
    estimatedCallCount: row.estimated_call_count, estimatedInputTokens: row.estimated_input_tokens, maximumOutputTokens: row.maximum_output_tokens,
    actualInputTokens: row.actual_input_tokens, actualOutputTokens: row.actual_output_tokens, actualTotalTokens: row.actual_total_tokens,
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
    const [versions, runs] = await Promise.all([
      db.prepare(`SELECT id, version, variant, parent_version_id, run_id, text, paragraphs_json, source_mapping_json, outline_json, validation_json, model_provider, model_name, prompt_version, model_call_id, change_summary, created_at FROM script_rewrite_versions WHERE organization_id = ? AND project_id = ? AND workspace_id = ? ORDER BY version DESC`).bind(organizationId, projectId, rewriteId).all(),
      db.prepare(`SELECT id, variant, status, source_version_id, result_version_id, retry_of_run_id, estimated_call_count, estimated_input_tokens, maximum_output_tokens, actual_input_tokens, actual_output_tokens, actual_total_tokens, model_call_id, prompt_version, validation_json, error_code, error_message, created_at, completed_at FROM script_rewrite_runs WHERE organization_id = ? AND project_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 100`).bind(organizationId, projectId, rewriteId).all(),
    ]);
    return Response.json({
      workspace: {
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
    if (parentVersionId) {
      const parent = await db.prepare("SELECT id FROM script_rewrite_versions WHERE id = ? AND organization_id = ? AND project_id = ? AND workspace_id = ?").bind(parentVersionId, organizationId, projectId, rewriteId).first();
      if (!parent) return apiError("REWRITE_PARENT_VERSION_NOT_FOUND", "要编辑的来源版本不存在。", 404);
    }
    const latest = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM script_rewrite_versions WHERE organization_id = ? AND project_id = ? AND workspace_id = ?").bind(organizationId, projectId, rewriteId).first<{ version: number }>();
    const version = Number(latest?.version ?? 0) + 1; const versionId = crypto.randomUUID(); const user = await ensureUser(identity); const now = new Date().toISOString(); const units = buildScriptUnits(body, SCRIPT_REWRITE_MAX_CHARACTERS);
    await db.batch([
      db.prepare(`INSERT INTO script_rewrite_versions (id, organization_id, project_id, workspace_id, version, variant, parent_version_id, run_id, text, paragraphs_json, source_mapping_json, outline_json, validation_json, model_provider, model_name, prompt_version, model_call_id, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, NULL, ?, ?, ?, '[]', '{}', NULL, NULL, NULL, NULL, ?, ?, ?)`).bind(versionId, organizationId, projectId, rewriteId, version, parentVersionId || null, body, JSON.stringify(units.map((item) => item.text)), JSON.stringify(units.map((item) => item.paragraphId)), clean(payload.changeSummary, 500) || "人工编辑保存", user.id, now),
      db.prepare("UPDATE script_rewrite_workspaces SET updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ?").bind(user.id, now, rewriteId, organizationId, projectId),
      db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'script_rewrite.manual_version_saved', 'script_rewrite_version', ?, ?, ?)`).bind(crypto.randomUUID(), organizationId, projectId, user.id, versionId, JSON.stringify({ workspaceId: rewriteId, version, parentVersionId: parentVersionId || null }), now),
    ]);
    return Response.json({ version: { id: versionId, version, variant: "manual", text: body, paragraphs: units.map((item) => item.text), parentVersionId: parentVersionId || null, createdAt: now } }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
