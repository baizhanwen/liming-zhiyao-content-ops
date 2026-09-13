import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { buildScriptUnits, SCRIPT_REWRITE_MAX_CHARACTERS } from "../../../lib/script-rewrite";
import { readRequestIdentity } from "../../../lib/request-auth";

export const dynamic = "force-dynamic";

const clean = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const parseJson = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
};
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const VIDEO_SOURCE_SELECT = `
  SELECT v.id, v.title, a.filename, v.created_at,
    (SELECT t.id FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'manual' ORDER BY t.version DESC LIMIT 1) AS manual_transcript_id,
    (SELECT t.version FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'manual' ORDER BY t.version DESC LIMIT 1) AS manual_transcript_version,
    (SELECT t.full_text FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'manual' ORDER BY t.version DESC LIMIT 1) AS manual_text,
    (SELECT t.id FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'asr' ORDER BY t.version DESC LIMIT 1) AS asr_transcript_id,
    (SELECT t.version FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'asr' ORDER BY t.version DESC LIMIT 1) AS asr_transcript_version,
    (SELECT t.full_text FROM video_transcripts t WHERE t.organization_id = v.organization_id AND t.project_id = v.project_id AND t.video_id = v.id AND t.source = 'asr' ORDER BY t.version DESC LIMIT 1) AS asr_text,
    (SELECT a.id FROM video_analyses a WHERE a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.video_id = v.id AND json_extract(a.report_json, '$.spoken_script_set.corrected_original.status') = 'completed' ORDER BY a.created_at DESC LIMIT 1) AS corrected_analysis_id,
    (SELECT a.report_json FROM video_analyses a WHERE a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.video_id = v.id AND json_extract(a.report_json, '$.spoken_script_set.corrected_original.status') = 'completed' ORDER BY a.created_at DESC LIMIT 1) AS corrected_report_json
  FROM videos v
  LEFT JOIN media_assets a ON a.id = v.media_asset_id AND a.organization_id = v.organization_id AND a.project_id = v.project_id AND a.status = 'active'
  WHERE v.organization_id = ? AND v.project_id = ? AND v.deleted_at IS NULL
`;

type VideoSourceRow = {
  id: string; title: string | null; filename: string | null; created_at: string;
  manual_transcript_id: string | null; manual_transcript_version: number | null; manual_text: string | null;
  asr_transcript_id: string | null; asr_transcript_version: number | null; asr_text: string | null;
  corrected_analysis_id: string | null; corrected_report_json: string | null;
};

function correctedAnalysisText(reportJson: string | null) {
  const report = record(parseJson(reportJson));
  const set = record(report?.spoken_script_set);
  const corrected = record(set?.corrected_original);
  if (corrected?.status !== "completed") return "";
  if (typeof corrected.text === "string" && corrected.text.trim()) return corrected.text.trim();
  if (!Array.isArray(corrected.paragraphs)) return "";
  return corrected.paragraphs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n\n").trim();
}

function chooseVideoSource(row: VideoSourceRow) {
  if (row.manual_transcript_id && row.manual_text?.trim()) return {
    available: true, text: row.manual_text.trim(), label: `人工校正版 · 转写 v${row.manual_transcript_version ?? "—"}`,
    transcriptId: row.manual_transcript_id, transcriptVersion: row.manual_transcript_version, analysisId: null,
  };
  const corrected = correctedAnalysisText(row.corrected_report_json);
  if (row.corrected_analysis_id && corrected) return {
    available: true, text: corrected, label: "AI 校正原版 · 来自最近一次视频分析",
    transcriptId: row.asr_transcript_id, transcriptVersion: row.asr_transcript_version, analysisId: row.corrected_analysis_id,
  };
  if (row.asr_transcript_id && row.asr_text?.trim()) return {
    available: true, text: row.asr_text.trim(), label: `ASR 原稿 · 转写 v${row.asr_transcript_version ?? "—"}`,
    transcriptId: row.asr_transcript_id, transcriptVersion: row.asr_transcript_version, analysisId: null,
  };
  return { available: false, text: "", label: "暂无转写，请先完成视频转写或改用粘贴文案", transcriptId: null, transcriptVersion: null, analysisId: null };
}

function publicVideoSource(row: VideoSourceRow) {
  const source = chooseVideoSource(row);
  return {
    id: row.id,
    title: row.title || row.filename || "未命名视频",
    createdAt: row.created_at,
    available: source.available,
    sourceLabel: source.label,
    sourceCharacters: source.text.length,
    preview: source.text.slice(0, 180),
    transcriptId: source.transcriptId,
    transcriptVersion: source.transcriptVersion,
    analysisId: source.analysisId,
  };
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问口播改写。", 401);
  const url = new URL(request.url);
  const organizationId = clean(url.searchParams.get("organizationId"), 100);
  const projectId = clean(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的口播改写。", 403);
    const db = getD1();
    const [workspaces, videos] = await Promise.all([
      db.prepare(`
        SELECT w.id, w.title, w.source_type, w.source_label, w.source_character_count, w.source_video_id, w.status, w.created_at, w.updated_at,
          (SELECT COUNT(*) FROM script_rewrite_versions v WHERE v.workspace_id = w.id) AS version_count,
          (SELECT variant FROM script_rewrite_versions v WHERE v.workspace_id = w.id ORDER BY version DESC LIMIT 1) AS latest_variant,
          (SELECT status FROM script_rewrite_runs r WHERE r.workspace_id = w.id ORDER BY created_at DESC LIMIT 1) AS latest_run_status
        FROM script_rewrite_workspaces w
        WHERE w.organization_id = ? AND w.project_id = ? AND w.status = 'active'
        ORDER BY w.updated_at DESC LIMIT 100
      `).bind(organizationId, projectId).all(),
      db.prepare(`${VIDEO_SOURCE_SELECT} ORDER BY v.created_at DESC LIMIT 100`).bind(organizationId, projectId).all<VideoSourceRow>(),
    ]);
    return Response.json({
      workspaces: workspaces.results,
      videos: videos.results.map(publicVideoSource),
      canWrite: canWriteProjectAccess(access),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再创建口播改写。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = clean(payload.organizationId, 100);
    const projectId = clean(payload.projectId, 100);
    const sourceType = payload.sourceType === "video" ? "video" : payload.sourceType === "pasted" ? "pasted" : "";
    if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
    if (!sourceType) return apiError("REWRITE_SOURCE_REQUIRED", "请选择粘贴文案或素材视频。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能创建口播改写。", 403);
    const user = await ensureUser(identity); const db = getD1();
    let sourceText = ""; let sourceLabel = "直接粘贴文案"; let sourceVideoId: string | null = null;
    let sourceTranscriptId: string | null = null; let sourceTranscriptVersion: number | null = null; let sourceAnalysisId: string | null = null; let defaultTitle = "粘贴文案改写";
    if (sourceType === "pasted") {
      sourceText = clean(payload.sourceText, SCRIPT_REWRITE_MAX_CHARACTERS + 1);
    } else {
      sourceVideoId = clean(payload.videoId, 100);
      if (!sourceVideoId) return apiError("REWRITE_VIDEO_REQUIRED", "请选择当前项目中的素材视频。", 400);
      const row = await db.prepare(`${VIDEO_SOURCE_SELECT} AND v.id = ? LIMIT 1`).bind(organizationId, projectId, sourceVideoId).first<VideoSourceRow>();
      if (!row) return apiError("REWRITE_VIDEO_NOT_FOUND", "素材视频不存在或不属于当前项目。", 404);
      const source = chooseVideoSource(row);
      if (!source.available) return apiError("REWRITE_TRANSCRIPT_REQUIRED", source.label, 409);
      sourceText = source.text; sourceLabel = source.label; sourceTranscriptId = source.transcriptId; sourceTranscriptVersion = source.transcriptVersion; sourceAnalysisId = source.analysisId;
      defaultTitle = `${row.title || row.filename || "素材视频"} · 口播改写`;
    }
    if (sourceText.length < 20) return apiError("REWRITE_SOURCE_TOO_SHORT", "来源文案至少需要 20 个字符。", 400);
    if (sourceText.length > SCRIPT_REWRITE_MAX_CHARACTERS) return apiError("REWRITE_SOURCE_TOO_LONG", `单个改写工作区最多支持 ${SCRIPT_REWRITE_MAX_CHARACTERS.toLocaleString("zh-CN")} 个字符。`, 413);
    const title = clean(payload.title, 160) || defaultTitle;
    const units = buildScriptUnits(sourceText, SCRIPT_REWRITE_MAX_CHARACTERS);
    if (!units.length) return apiError("REWRITE_SOURCE_INVALID", "来源文案没有可用段落。", 400);
    const sourceHash = await sha256Hex(new TextEncoder().encode(sourceText));
    const workspaceId = crypto.randomUUID(); const sourceVersionId = crypto.randomUUID(); const now = new Date().toISOString();
    await db.batch([
      db.prepare(`INSERT INTO script_rewrite_workspaces (id, organization_id, project_id, title, source_type, source_video_id, source_transcript_id, source_transcript_version, source_analysis_id, source_label, source_text, source_hash, source_character_count, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`).bind(workspaceId, organizationId, projectId, title, sourceType, sourceVideoId, sourceTranscriptId, sourceTranscriptVersion, sourceAnalysisId, sourceLabel, sourceText, sourceHash, sourceText.length, user.id, user.id, now, now),
      db.prepare(`INSERT INTO script_rewrite_versions (id, organization_id, project_id, workspace_id, version, variant, parent_version_id, run_id, text, paragraphs_json, source_mapping_json, outline_json, validation_json, model_provider, model_name, prompt_version, model_call_id, change_summary, created_by, created_at) VALUES (?, ?, ?, ?, 1, 'source', NULL, NULL, ?, ?, ?, '[]', '{}', NULL, NULL, NULL, NULL, ?, ?, ?)`).bind(sourceVersionId, organizationId, projectId, workspaceId, sourceText, JSON.stringify(units.map((item) => item.text)), JSON.stringify(units.map((item) => item.paragraphId)), sourceLabel, user.id, now),
      db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'script_rewrite.created', 'script_rewrite_workspace', ?, ?, ?)`).bind(crypto.randomUUID(), organizationId, projectId, user.id, workspaceId, JSON.stringify({ sourceType, sourceVideoId, sourceTranscriptId, sourceTranscriptVersion, sourceAnalysisId, sourceHash, sourceCharacters: sourceText.length }), now),
    ]);
    return Response.json({ workspace: { id: workspaceId, title, sourceType, sourceLabel, sourceCharacters: sourceText.length }, sourceVersionId }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
