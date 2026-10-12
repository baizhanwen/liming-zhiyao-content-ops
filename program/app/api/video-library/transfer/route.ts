import { MATERIAL_MAX_ENTRIES as MAX_ENTRIES, MATERIAL_MAX_ASSETS_PER_ENTRY as MAX_ASSETS_PER_ENTRY, MATERIAL_MAX_MEDIA_BYTES as MAX_IMPORT_BYTES, MATERIAL_MAX_MANIFEST_BYTES } from "../../../../lib/material-transfer-limits";
import { assertJsonByteBudget, JsonByteBudgetExceededError } from "../../../../lib/json-byte-budget";
import { canManageOrganizationVideoLibrary, canWriteProjectAccess, ensureUser, getD1, getMediaBucket, getOrganizationAccess, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { createProjectWriteAssertion, ProjectWriteAccessChangedError, projectWriteAccessCondition, projectWriteAccessBindings } from "../../../../lib/project-write-access";
import { readBoundedFormData, RequestBodyError } from "../../../../lib/bounded-request-body";

import { importedAnalysisState } from "../../../../lib/material-analysis-state";

const FORMAT = "liming-video-library-package";

type Row = Record<string, unknown>;
type ManifestAsset = { blobName: string; id: string; kind: string; filename: string; contentType: string; sizeBytes: number; sha256: string; isCover?: number; qualityScore?: number | null; downloadUrl?: string };
type ManifestEntry = {
  library: { category: string; tags: string[]; notes: string | null };
  video: Row;
  assets: ManifestAsset[];
  transcripts: Row[];
  analyses: Row[];
  metrics: Row[];
};

function invalidManifest(message: string): never { throw new RequestBodyError("INVALID_MATERIAL_MANIFEST", message, 400); }
function cleanText(value: unknown, maximum: number, required = false) {
  if (value == null) return required ? null : "";
  if (typeof value !== "string") return invalidManifest("迁移包中的文本字段类型不正确。");
  if (value.length > maximum) return invalidManifest(`迁移包文本超过 ${maximum} 字符上限，未裁剪；请分批整理或使用完整备份。`);
  return required && !value.trim() ? null : value;
}
function cleanFilename(value: unknown) { return Array.from(cleanText(value, 160) || "media", (character) => character.charCodeAt(0) < 32 || "\\/:*?\"<>|".includes(character) ? "-" : character).join(""); }
function cleanJson(value: unknown, fallback: string, maximum = 2_000_000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? JSON.parse(fallback));
  if (text.length > maximum) return invalidManifest("迁移包中的结构化数据过大，未裁剪；请分批整理或使用完整备份。");
  try { JSON.parse(text); } catch { return invalidManifest("迁移包中的结构化数据不是有效 JSON。"); }
  return text;
}
function cleanStringList(value: unknown, maximum = 20) {
  if (!Array.isArray(value) || value.length > maximum) return invalidManifest(`迁移包标签须为数组且不超过 ${maximum} 个，未裁剪。`);
  return value.map(item => { if (typeof item !== "string" || item.length > 50) return invalidManifest("迁移包标签须为不超过 50 字符的文本，未裁剪。"); return item; });
}
function asInteger(value: unknown) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) return invalidManifest("迁移包数值不是有效整数，未替换为 0 或空值。");
  return number;
}
function qualityScore(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return invalidManifest("封面质量分数无效。");
  return value;
}

async function requireLibraryManager(request: Request, organizationId: string) {
  const identity = await readRequestIdentity(request); if (!identity) return { response: apiError("AUTH_REQUIRED", "请先登录后再迁移素材中心。", 401) };
  const access = await getOrganizationAccess(identity.authSubject, organizationId);
  if (!access || !await canManageOrganizationVideoLibrary(access)) return { response: apiError("LIBRARY_MANAGER_REQUIRED", "当前角色不能导入或导出公司素材。", 403) };
  return { identity, access };
}

function groupRows(rows: Row[], key: string) {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) { const id = String(row[key] ?? ""); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id)!.push(row); }
  return grouped;
}

export async function GET(request: Request) {
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const requestedIds = [...new Set((url.searchParams.get("entryIds") || "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  const authorization = await requireLibraryManager(request, organizationId); if (authorization.response) return authorization.response;
  try {
    if (requestedIds.length > MAX_ENTRIES) return apiError("EXPORT_SELECTION_TOO_LARGE", `一次最多导出 ${MAX_ENTRIES} 条素材，请减少选择；本次未导出。`, 400);
    const db = getD1(); const idFilter = requestedIds.length ? " AND library.id IN (SELECT value FROM json_each(?))" : "";
    const entries = await db.prepare(`
      SELECT library.id AS entry_id, library.category, library.tags_json, library.notes,
        v.id AS video_id, v.media_asset_id, v.platform, v.source_type, v.source_url, v.source_hash, v.platform_work_id, v.title, v.author_name, v.published_at, v.duration_sec, v.status
      FROM video_library_entries library INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      WHERE library.organization_id = ? AND v.deleted_at IS NULL${idFilter}
      ORDER BY library.updated_at DESC LIMIT ${MAX_ENTRIES + 1}
    `).bind(organizationId, ...(requestedIds.length ? [JSON.stringify(requestedIds)] : [])).all<Row>();
    if (entries.results.length > MAX_ENTRIES) return apiError("EXPORT_SELECTION_TOO_LARGE", `一次最多导出 ${MAX_ENTRIES} 条素材，请先筛选或分批导出。`, 400);
    if (requestedIds.length && entries.results.length !== requestedIds.length) return apiError("LIBRARY_EXPORT_CHANGED", "所选素材已删除、不存在或不属于当前公司，本次未导出。请刷新后重新选择。", 409);
    if (!entries.results.length) return apiError("LIBRARY_EMPTY", "没有可导出的素材。", 404);
    const videoIds = entries.results.map((row) => String(row.video_id)); const videoFilter = "SELECT value FROM json_each(?)";
    // Aggregate before loading report bodies or handing download links to a
    // browser: oversized selections must be split, never silently truncated.
    const budgetRows = await db.prepare(`
      SELECT 'assets' AS kind, video_id, COUNT(*) AS n, SUM(MAX(size_bytes,0)) AS bytes FROM media_assets WHERE organization_id=? AND video_id IN (${videoFilter}) AND status='active' GROUP BY video_id
      UNION ALL SELECT 'transcripts', video_id, COUNT(*), SUM(length(CAST(COALESCE(full_text,'') AS BLOB))+length(CAST(COALESCE(segments_json,'') AS BLOB))) FROM video_transcripts WHERE organization_id=? AND video_id IN (${videoFilter}) GROUP BY video_id
      UNION ALL SELECT 'analyses', video_id, COUNT(*), SUM(length(CAST(COALESCE(report_json,'') AS BLOB))) FROM video_analyses WHERE organization_id=? AND video_id IN (${videoFilter}) GROUP BY video_id
      UNION ALL SELECT 'metrics', video_id, COUNT(*), 0 FROM video_metric_snapshots WHERE organization_id=? AND video_id IN (${videoFilter}) GROUP BY video_id
    `).bind(...Array.from({length:4},()=>[organizationId,JSON.stringify(videoIds)]).flat()).all<{kind:string;video_id:string;n:number;bytes:number}>();
    let mediaBytes = 0, textBytes = 0;
    for (const row of budgetRows.results) {
      const limit = row.kind === "assets" ? MAX_ASSETS_PER_ENTRY : row.kind === "metrics" ? 100 : 20;
      if (row.n > limit) throw new RequestBodyError("MATERIAL_RECORD_LIMIT", "所选素材的子记录超过迁移格式上限，未导出；请分批整理或使用完整备份。", 400);
      if (row.kind === "assets") mediaBytes += row.bytes; else textBytes += row.bytes;
    }
    if (mediaBytes > MAX_IMPORT_BYTES) throw new RequestBodyError("MATERIAL_PACKAGE_TOO_LARGE", "所选媒体合计超过 750 MiB，未导出；请减少选择后分批迁移。", 413);
    if (textBytes > MATERIAL_MAX_MANIFEST_BYTES) throw new RequestBodyError("MATERIAL_MANIFEST_TOO_LARGE", "所选清单超过 20000000 字节，未导出；请减少选择或使用完整备份。", 413);
    const [assets, transcripts, analyses, metrics] = await Promise.all([
      db.prepare(`SELECT id, video_id, kind, filename, content_type, size_bytes, sha256, is_cover, quality_score FROM media_assets WHERE organization_id = ? AND video_id IN (${videoFilter}) AND status = 'active' ORDER BY created_at`).bind(organizationId, JSON.stringify(videoIds)).all<Row>(),
      db.prepare(`SELECT video_id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY version`).bind(organizationId, JSON.stringify(videoIds)).all<Row>(),
      db.prepare(`SELECT video_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at, updated_at FROM video_analyses WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY created_at`).bind(organizationId, JSON.stringify(videoIds)).all<Row>(),
      db.prepare(`SELECT video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_at FROM video_metric_snapshots WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY collected_at`).bind(organizationId, JSON.stringify(videoIds)).all<Row>(),
    ]);
    const assetGroups = groupRows(assets.results, "video_id"); const transcriptGroups = groupRows(transcripts.results, "video_id"); const analysisGroups = groupRows(analyses.results, "video_id"); const metricGroups = groupRows(metrics.results, "video_id");
    const payload = {
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      entries: entries.results.map((row) => {
        const videoId = String(row.video_id); const entryId = String(row.entry_id); const mediaAssetId = row.media_asset_id ? String(row.media_asset_id) : null;
        const entryAssets = (assetGroups.get(videoId) || []).map((asset) => {
          const blobName = `asset-${asset.id}`;
          return { blobName, id: asset.id, kind: asset.kind, filename: asset.filename, contentType: asset.content_type, sizeBytes: asset.size_bytes, sha256: asset.sha256, isCover: asset.is_cover, qualityScore: asset.quality_score, downloadUrl: `/api/video-library/${entryId}/assets/${asset.id}?organizationId=${encodeURIComponent(organizationId)}` };
        });
        if (mediaAssetId && !entryAssets.some(asset => String(asset.id) === mediaAssetId)) throw new RequestBodyError("MATERIAL_SOURCE_MISSING", "所选素材的主附件关联已失效，本次未导出。请先核对附件状态。", 409);
        return {
          library: { category: row.category, tags: JSON.parse(String(row.tags_json || "[]")), notes: row.notes },
          video: { platform: row.platform, sourceType: row.source_type, sourceUrl: row.source_url, sourceHash: row.source_hash, platformWorkId: row.platform_work_id, title: row.title, authorName: row.author_name, publishedAt: row.published_at, durationSec: row.duration_sec, status: row.status, sourceMediaBlobName: entryAssets.find((asset) => String(asset.id) === mediaAssetId)?.blobName ?? null },
          assets: entryAssets, transcripts: transcriptGroups.get(videoId) || [], analyses: analysisGroups.get(videoId) || [], metrics: metricGroups.get(videoId) || [],
        };
      }),
    };
    validateManifest(payload);
    try { assertJsonByteBudget(payload, MATERIAL_MAX_MANIFEST_BYTES); }
    catch (error) {
      if (error instanceof JsonByteBudgetExceededError) throw new RequestBodyError("MATERIAL_MANIFEST_TOO_LARGE", "所选清单超过 20000000 字节，未导出；请减少选择或使用完整备份。", 413);
      throw error;
    }
    const serialized = JSON.stringify(payload);
    return new Response(serialized, { headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
  } catch (error) { return error instanceof RequestBodyError ? apiError(error.code, error.message, error.status) : errorResponse(error); }
}

function validateManifest(value: unknown) {
  if (!value || typeof value !== "object") throw new RequestBodyError("INVALID_MATERIAL_MANIFEST", "素材包清单格式不正确。", 400);
  const payload = value as Record<string, unknown>;
  if (payload.format !== FORMAT || payload.version !== 1 || !Array.isArray(payload.entries)) throw new RequestBodyError("INVALID_MATERIAL_MANIFEST", "请选择由本系统导出的素材中心迁移包。", 400);
  if (!payload.entries.length || payload.entries.length > MAX_ENTRIES) throw new RequestBodyError("INVALID_MATERIAL_MANIFEST", `素材包必须包含 1 到 ${MAX_ENTRIES} 条素材。`, 400);
  for (const entry of payload.entries as ManifestEntry[]) {
    if (!entry || typeof entry !== "object" || !entry.video || !entry.library) throw new RequestBodyError("INVALID_MATERIAL_MANIFEST", "素材包中存在不完整的素材记录。", 400);
    for (const [field, limit] of [["assets", MAX_ASSETS_PER_ENTRY], ["transcripts", 20], ["analyses", 20], ["metrics", 100]] as const) {
      if (entry[field] != null && !Array.isArray(entry[field])) return invalidManifest(`迁移包的 ${field} 须为数组。`);
      if (Array.isArray(entry[field]) && entry[field].length > limit) throw new RequestBodyError("MATERIAL_RECORD_LIMIT", `单条素材的 ${field} 超过 ${limit} 条，未截断或导入，请分批迁移或使用完整备份。`, 400);
    }
    if (typeof entry.video !== "object" || Array.isArray(entry.video) || typeof entry.library !== "object" || Array.isArray(entry.library)) return invalidManifest("素材信息须为对象。");
    for (const [field, limit] of [["sourceHash",128],["sourceUrl",2000],["platformWorkId",200],["title",500],["authorName",300],["publishedAt",40]] as const) cleanText(entry.video[field],limit);
    asInteger(entry.video.durationSec); cleanText(entry.library.notes,1000); cleanStringList(entry.library.tags,12);
    const names = new Set<string>();
    for (const asset of entry.assets ?? []) {
      if (!asset || typeof asset !== "object") return invalidManifest("迁移包附件信息须为对象。");
      const name=cleanText(asset.blobName,200,true); if (!name || names.has(name)) return invalidManifest("迁移包附件名缺失或重复。"); names.add(name);
      cleanText(asset.filename,160); cleanText(asset.contentType,120);
      if (!["source_video","source_audio","keyframe","subtitle","report"].includes(asset.kind)) return invalidManifest("迁移包附件类型无效。");
      if (asset.isCover != null && asset.isCover !== 0 && asset.isCover !== 1) return invalidManifest("封面标记须为 0 或 1。"); qualityScore(asset.qualityScore);
    }
    const primary=cleanText(entry.video.sourceMediaBlobName,200); if (primary && !names.has(primary)) return invalidManifest("迁移包主附件未列入附件清单，未导入。");
    for (const transcript of entry.transcripts ?? []) {
      if (!transcript || typeof transcript !== "object") return invalidManifest("转写记录须为对象。");
      asInteger(transcript.version); asInteger(transcript.confidence); cleanText(transcript.language,40); cleanText(transcript.full_text,2_000_000); cleanJson(transcript.segments_json,"[]"); cleanText(transcript.created_at,40); cleanText(transcript.updated_at,40);
    }
    for (const analysis of entry.analyses ?? []) {
      if (!analysis || typeof analysis !== "object") return invalidManifest("分析记录须为对象。");
      asInteger(analysis.confidence); cleanText(analysis.schema_version,100); cleanJson(analysis.report_json,"{}"); cleanText(analysis.model_provider,100); cleanText(analysis.model_name,150); cleanText(analysis.prompt_version,150); cleanText(analysis.created_at,40); cleanText(analysis.updated_at,40);
    }
    for (const metric of entry.metrics ?? []) {
      if (!metric || typeof metric !== "object") return invalidManifest("指标记录须为对象。");
      for (const field of ["plays","likes","comments","favorites","shares","followers_gained"]) asInteger(metric[field]); cleanText(metric.collected_at,40); cleanText(metric.created_at,40);
    }
  }
  return payload.entries as ManifestEntry[];
}

function prepareMaterialInsert(db: D1Database, marker: string, sql: string) {
  const split = sql.indexOf(" VALUES (");
  if (split < 0 || !sql.endsWith(")")) throw new Error("Unsupported material insert statement");
  const guarded = `${sql.slice(0, split)} SELECT ${sql.slice(split + 9, -1)} WHERE EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`;
  return { bind: (...values: unknown[]) => db.prepare(guarded).bind(...values, marker) };
}

export async function POST(request: Request) {
  let imported = 0, skipped = 0, entryIndex = 0, entryCount = 0;
  const progress = () => ({ imported, skipped, failedEntry: entryCount ? entryIndex + 1 : null, remaining: Math.max(0, entryCount - entryIndex) });
  const progressError = (code: string, message: string, status: number) => Response.json({ error: { code, message }, progress: progress() }, { status });
  const failure = async (error: unknown) => {
    const response = error instanceof ProjectWriteAccessChangedError
      ? apiError(error.code, "登录状态或目标项目权限已改变，已停止后续素材导入。请刷新核对已导入条目后再操作。", 403)
      : error instanceof RequestBodyError ? apiError(error.code, error.message, error.status) : errorResponse(error);
    return Response.json({ ...await response.json() as object, progress: progress() }, { status: response.status });
  };
  try {
    if (!await readRequestIdentity(request)) return apiError("AUTH_REQUIRED", "请先登录后再迁移素材中心。", 401);
    const form = await readBoundedFormData(request, MAX_IMPORT_BYTES + MATERIAL_MAX_MANIFEST_BYTES + 1024 * 1024, "迁移请求过大，请分批导入；媒体合计最多 750 MiB，清单最多 20000000 字节。"); const organizationId = cleanText(form.get("organizationId"), 100, true)?.trim(); const projectId = cleanText(form.get("projectId"), 100, true)?.trim(); const manifestText = cleanText(form.get("manifest"), 20_000_000, true);
    if (!organizationId || !projectId || !manifestText) return apiError("IMPORT_SCOPE_REQUIRED", "缺少公司、目标项目或素材包清单。", 400);
    const authorization = await requireLibraryManager(request, organizationId); if (authorization.response) return authorization.response;
    const projectAccess = await getProjectAccess(authorization.identity!.authSubject, organizationId, projectId);
    if (!projectAccess || !canWriteProjectAccess(projectAccess)) return apiError("PROJECT_WRITE_REQUIRED", "你不能把素材导入这个目标项目。", 403);
    if (new TextEncoder().encode(manifestText).byteLength > MATERIAL_MAX_MANIFEST_BYTES) return apiError("MATERIAL_MANIFEST_TOO_LARGE", "迁移清单最多 20000000 字节，请分批迁移。", 413);
    const entries = validateManifest(JSON.parse(manifestText)); entryCount = entries.length; const files = new Map<string, File>(); let totalBytes = 0;
    for (const value of form.getAll("media")) if (value instanceof File) { totalBytes += value.size; files.set(value.name, value); }
    if (totalBytes > MAX_IMPORT_BYTES) return apiError("MATERIAL_PACKAGE_TOO_LARGE", "单次导入包解压后不能超过 750 MiB，请分批迁移。", 413);
    const user = await ensureUser(authorization.identity!); const db = getD1(); const bucket = getMediaBucket();
    const scope = { organizationId, projectId, userId: user.id };
    const assertAccess = createProjectWriteAssertion(db, scope, async () => (await readRequestIdentity(request))?.authSubject === authorization.identity!.authSubject);
    for (const [index, rawEntry] of entries.entries()) {
      entryIndex = index; await assertAccess();
      if (!rawEntry || typeof rawEntry !== "object" || !rawEntry.video || !rawEntry.library) throw new Error("素材包中存在不完整的素材记录。");
      const sourceHash = cleanText(rawEntry.video.sourceHash, 128); const sourceUrl = cleanText(rawEntry.video.sourceUrl, 2_000);
      const duplicate = sourceHash
        ? await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_hash = ? AND deleted_at IS NULL LIMIT 1").bind(organizationId, projectId, sourceHash).first<{ id: string }>()
        : sourceUrl ? await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_url = ? AND deleted_at IS NULL LIMIT 1").bind(organizationId, projectId, sourceUrl).first<{ id: string }>() : null;
      if (duplicate) { skipped += 1; continue; }
      const assets = Array.isArray(rawEntry.assets) ? rawEntry.assets : []; if (assets.length > MAX_ASSETS_PER_ENTRY) throw new Error(`单条素材最多携带 ${MAX_ASSETS_PER_ENTRY} 个媒体文件。`);
      const videoId = crypto.randomUUID(); const libraryEntryId = crypto.randomUUID(); const marker = crypto.randomUUID(); const now = new Date().toISOString(); const entryKeys: string[] = []; const assetIds = new Map<string, string>();
      try {
        for (const rawAsset of assets) {
          const blobName = cleanText(rawAsset.blobName, 200, true); const file = blobName ? files.get(blobName) : undefined; if (!blobName || !file) throw new Error(`素材文件 ${blobName || "(未命名)"} 缺失。`);
          const bytes = await file.arrayBuffer(); const digest = await sha256Hex(bytes); if (rawAsset.sha256 && digest !== rawAsset.sha256) throw new Error(`素材文件 ${rawAsset.filename} 校验失败，迁移包可能不完整。`);
          const assetId = crypto.randomUUID(); const filename = cleanFilename(rawAsset.filename); const kind = cleanText(rawAsset.kind, 30, true); const contentType = cleanText(rawAsset.contentType, 120) || file.type || "application/octet-stream";
          if (!kind || !["source_video", "source_audio", "keyframe", "subtitle", "report"].includes(kind)) throw new Error("素材包包含不支持的媒体类型。");
          const r2Key = `organizations/${organizationId}/projects/${projectId}/videos/${videoId}/import/${assetId}-${filename}`;
          await assertAccess(); entryKeys.push(r2Key);
          const stored = await bucket.put(r2Key, bytes, { httpMetadata: { contentType }, customMetadata: { organizationId, projectId, videoId, sha256: digest, imported: "true" } });
          if (!stored) throw new Error("素材文件写入未确认。");
          assetIds.set(blobName, assetId);
          rawAsset.id = assetId; rawAsset.filename = filename; rawAsset.contentType = contentType; rawAsset.sizeBytes = bytes.byteLength; rawAsset.sha256 = digest; rawAsset.downloadUrl = r2Key;
        }
        const analysisState = importedAnalysisState(rawEntry.analyses ?? [], now);
        const sourceMediaId = cleanText(rawEntry.video.sourceMediaBlobName, 200) ? assetIds.get(String(rawEntry.video.sourceMediaBlobName)) ?? null : null;
        const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
          SELECT ?,?,?,?,'video_library.imported','video_library_entry',?,?,? WHERE ${projectWriteAccessCondition}`)
          .bind(marker, organizationId, projectId, user.id, libraryEntryId, JSON.stringify({ assetCount: assets.length }), now, ...projectWriteAccessBindings(scope))];
        statements.push(prepareMaterialInsert(db, marker, "INSERT INTO videos (id, organization_id, project_id, social_account_id, media_asset_id, platform, source_type, source_url, source_hash, platform_work_id, title, author_name, published_at, duration_sec, status, error_message, created_by, updated_by, deleted_at, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").bind(videoId, organizationId, projectId, rawEntry.video.platform === "upload" ? "upload" : "douyin", rawEntry.video.sourceType === "upload" ? "upload" : "url", sourceUrl || null, sourceHash || null, cleanText(rawEntry.video.platformWorkId, 200) || null, cleanText(rawEntry.video.title, 500) || null, cleanText(rawEntry.video.authorName, 300) || null, cleanText(rawEntry.video.publishedAt, 40) || null, asInteger(rawEntry.video.durationSec), analysisState.videoStatus, analysisState.message, user.id, user.id, now, now));
        for (const asset of assets) statements.push(prepareMaterialInsert(db, marker, "INSERT INTO media_assets (id, organization_id, project_id, video_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, is_cover, quality_score, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)").bind(asset.id, organizationId, projectId, videoId, asset.kind, asset.downloadUrl, asset.filename, asset.contentType, asset.sizeBytes, asset.sha256, asset.isCover ?? 0, qualityScore(asset.qualityScore), user.id, user.id, now, now));
        if (sourceMediaId) statements.push(db.prepare("UPDATE videos SET media_asset_id = ? WHERE id = ? AND EXISTS(SELECT 1 FROM audit_logs WHERE id=?)").bind(sourceMediaId, videoId, marker));
        for (const transcript of (Array.isArray(rawEntry.transcripts) ? rawEntry.transcripts : [])) statements.push(prepareMaterialInsert(db, marker, "INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source, full_text, segments_json, confidence, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, asInteger(transcript.version) || 1, cleanText(transcript.language, 40) || "zh-CN", transcript.source === "manual" ? "manual" : "asr", cleanText(transcript.full_text, 2_000_000) || "", cleanJson(transcript.segments_json, "[]"), asInteger(transcript.confidence), user.id, cleanText(transcript.created_at,40) || now, cleanText(transcript.updated_at,40) || now));
        for (const analysis of (Array.isArray(rawEntry.analyses) ? rawEntry.analyses : [])) statements.push(prepareMaterialInsert(db, marker, "INSERT INTO video_analyses (id, organization_id, project_id, video_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, cleanText(analysis.schema_version, 100) || "imported.v1", cleanJson(analysis.report_json, "{}"), asInteger(analysis.confidence), cleanText(analysis.model_provider, 100) || null, cleanText(analysis.model_name, 150) || null, cleanText(analysis.prompt_version, 150) || null, user.id, cleanText(analysis.created_at,40) || now, cleanText(analysis.updated_at,40) || now));
        for (const metric of (Array.isArray(rawEntry.metrics) ? rawEntry.metrics : [])) statements.push(prepareMaterialInsert(db, marker, "INSERT INTO video_metric_snapshots (id, organization_id, project_id, video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, ["public", "client_backend", "manual"].includes(String(metric.source)) ? metric.source : "manual", asInteger(metric.plays), asInteger(metric.likes), asInteger(metric.comments), asInteger(metric.favorites), asInteger(metric.shares), asInteger(metric.followers_gained), cleanText(metric.collected_at, 40) || now, user.id, cleanText(metric.created_at,40) || now));
        if (analysisState.jobStatus) statements.push(prepareMaterialInsert(db, marker, "INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, input_transcript_id, source_type, source_ref, idempotency_key, status, analysis_profile, progress, current_stage, retry_count, attempt_count, version, resume_count, error_code, error_message, created_by, updated_by, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'standard', 100, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, rawEntry.video.sourceType === "upload" ? "upload" : "url", sourceUrl || `import:${videoId}`, `material-import:${crypto.randomUUID()}`, analysisState.jobStatus, analysisState.stage, analysisState.errorCode, analysisState.message, user.id, user.id, now, now, now));
        statements.push(prepareMaterialInsert(db, marker, "INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, notes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(libraryEntryId, organizationId, videoId, ["published", "benchmark", "industry", "case", "trend", "creative", "other"].includes(String(rawEntry.library.category)) ? rawEntry.library.category : "other", JSON.stringify(cleanStringList(rawEntry.library.tags, 12)), cleanText(rawEntry.library.notes, 1_000) || null, user.id, user.id, now, now));
        await assertAccess();
        const results = await db.batch(statements);
        if (!results[0].meta.changes) throw new ProjectWriteAccessChangedError();
        imported += 1;
      } catch (error) {
        // A thrown batch may already have committed. The marker shares the
        // transaction with every dependent row; never delete linked objects.
        let committed;
        try { committed = await db.prepare("SELECT id FROM audit_logs WHERE id=? AND organization_id=? AND project_id=? AND target_id=? AND action='video_library.imported'").bind(marker,organizationId,projectId,libraryEntryId).first(); }
        catch { return progressError("MATERIAL_IMPORT_STATUS_UNKNOWN", "素材保存结果暂时无法核对，文件已保留。请恢复数据服务并刷新核对后再决定重试。", 503); }
        if (committed) { imported += 1; continue; }
        const cleanup = await Promise.allSettled(entryKeys.map(key => bucket.delete(key)));
        if (cleanup.some(result => result.status === "rejected")) return progressError("MATERIAL_IMPORT_CLEANUP_PENDING", "本条素材未入库，但暂存文件清理失败。请联系管理员核对后再重试。", 503);
        return await failure(error);
      }
    }
    return Response.json({ imported, skipped });
  } catch (error) { return await failure(error); }
}
