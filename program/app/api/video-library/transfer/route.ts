import { canManageOrganizationVideoLibrary, canWriteProjectAccess, ensureUser, getD1, getMediaBucket, getOrganizationAccess, getProjectAccess, sha256Hex } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

const FORMAT = "liming-video-library-package";
const MAX_ENTRIES = 100;
const MAX_ASSETS_PER_ENTRY = 120;
const MAX_IMPORT_BYTES = 750 * 1024 * 1024;

type Row = Record<string, unknown>;
type ManifestAsset = { blobName: string; id: string; kind: string; filename: string; contentType: string; sizeBytes: number; sha256: string; downloadUrl?: string };
type ManifestEntry = {
  library: { category: string; tags: string[]; notes: string | null };
  video: Row;
  assets: ManifestAsset[];
  transcripts: Row[];
  analyses: Row[];
  metrics: Row[];
};

function placeholders(size: number) { return Array.from({ length: size }, () => "?").join(","); }
function cleanText(value: unknown, maximum: number, required = false) { const result = typeof value === "string" ? value.replaceAll("\0", "").trim().slice(0, maximum) : ""; return required && !result ? null : result; }
function cleanFilename(value: unknown) { return Array.from(cleanText(value, 160) || "media", (character) => character.charCodeAt(0) < 32 || "\\/:*?\"<>|".includes(character) ? "-" : character).join(""); }
function cleanJson(value: unknown, fallback: string, maximum = 2_000_000) { const text = typeof value === "string" ? value.trim() : JSON.stringify(value ?? JSON.parse(fallback)); if (text.length > maximum) throw new Error("迁移包中的结构化数据过大。"); JSON.parse(text); return text; }
function cleanStringList(value: unknown, maximum = 20) { return Array.isArray(value) ? [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 50)] : []))].slice(0, maximum) : []; }
function asInteger(value: unknown) { const number = Number(value); return Number.isSafeInteger(number) ? number : null; }

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
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const requestedIds = [...new Set((url.searchParams.get("entryIds") || "").split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX_ENTRIES);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  const authorization = await requireLibraryManager(request, organizationId); if (authorization.response) return authorization.response;
  try {
    const db = getD1(); const idFilter = requestedIds.length ? ` AND library.id IN (${placeholders(requestedIds.length)})` : "";
    const entries = await db.prepare(`
      SELECT library.id AS entry_id, library.category, library.tags_json, library.notes,
        v.id AS video_id, v.media_asset_id, v.platform, v.source_type, v.source_url, v.source_hash, v.platform_work_id, v.title, v.author_name, v.published_at, v.duration_sec, v.status
      FROM video_library_entries library INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      WHERE library.organization_id = ? AND v.deleted_at IS NULL${idFilter}
      ORDER BY library.updated_at DESC LIMIT ${MAX_ENTRIES + 1}
    `).bind(organizationId, ...requestedIds).all<Row>();
    if (entries.results.length > MAX_ENTRIES) return apiError("EXPORT_SELECTION_TOO_LARGE", `一次最多导出 ${MAX_ENTRIES} 条素材，请先筛选或分批导出。`, 400);
    if (!entries.results.length) return apiError("LIBRARY_EMPTY", "没有可导出的素材。", 404);
    const videoIds = entries.results.map((row) => String(row.video_id)); const videoFilter = placeholders(videoIds.length);
    const [assets, transcripts, analyses, metrics] = await Promise.all([
      db.prepare(`SELECT id, video_id, kind, filename, content_type, size_bytes, sha256 FROM media_assets WHERE organization_id = ? AND video_id IN (${videoFilter}) AND status = 'active' ORDER BY created_at`).bind(organizationId, ...videoIds).all<Row>(),
      db.prepare(`SELECT video_id, version, language, source, full_text, segments_json, confidence, created_at, updated_at FROM video_transcripts WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY version`).bind(organizationId, ...videoIds).all<Row>(),
      db.prepare(`SELECT video_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_at, updated_at FROM video_analyses WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY created_at`).bind(organizationId, ...videoIds).all<Row>(),
      db.prepare(`SELECT video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_at FROM video_metric_snapshots WHERE organization_id = ? AND video_id IN (${videoFilter}) ORDER BY collected_at`).bind(organizationId, ...videoIds).all<Row>(),
    ]);
    const assetGroups = groupRows(assets.results, "video_id"); const transcriptGroups = groupRows(transcripts.results, "video_id"); const analysisGroups = groupRows(analyses.results, "video_id"); const metricGroups = groupRows(metrics.results, "video_id");
    const payload = {
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      entries: entries.results.map((row) => {
        const videoId = String(row.video_id); const entryId = String(row.entry_id); const mediaAssetId = row.media_asset_id ? String(row.media_asset_id) : null;
        const entryAssets = (assetGroups.get(videoId) || []).map((asset) => {
          const blobName = `asset-${asset.id}`;
          return { blobName, id: asset.id, kind: asset.kind, filename: asset.filename, contentType: asset.content_type, sizeBytes: asset.size_bytes, sha256: asset.sha256, downloadUrl: `/api/video-library/${entryId}/assets/${asset.id}?organizationId=${encodeURIComponent(organizationId)}` };
        });
        return {
          library: { category: row.category, tags: JSON.parse(String(row.tags_json || "[]")), notes: row.notes },
          video: { platform: row.platform, sourceType: row.source_type, sourceUrl: row.source_url, sourceHash: row.source_hash, platformWorkId: row.platform_work_id, title: row.title, authorName: row.author_name, publishedAt: row.published_at, durationSec: row.duration_sec, status: row.status, sourceMediaBlobName: entryAssets.find((asset) => String(asset.id) === mediaAssetId)?.blobName ?? null },
          assets: entryAssets, transcripts: transcriptGroups.get(videoId) || [], analyses: analysisGroups.get(videoId) || [], metrics: metricGroups.get(videoId) || [],
        };
      }),
    };
    return Response.json(payload, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

function validateManifest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("素材包清单格式不正确。");
  const payload = value as Record<string, unknown>;
  if (payload.format !== FORMAT || payload.version !== 1 || !Array.isArray(payload.entries)) throw new Error("请选择由本系统导出的素材中心迁移包。");
  if (!payload.entries.length || payload.entries.length > MAX_ENTRIES) throw new Error(`素材包必须包含 1 到 ${MAX_ENTRIES} 条素材。`);
  return payload.entries as ManifestEntry[];
}

export async function POST(request: Request) {
  let storedKeys: string[] = [];
  try {
    const form = await request.formData(); const organizationId = cleanText(form.get("organizationId"), 100, true); const projectId = cleanText(form.get("projectId"), 100, true); const manifestText = cleanText(form.get("manifest"), 20_000_000, true);
    if (!organizationId || !projectId || !manifestText) return apiError("IMPORT_SCOPE_REQUIRED", "缺少公司、目标项目或素材包清单。", 400);
    const authorization = await requireLibraryManager(request, organizationId); if (authorization.response) return authorization.response;
    const projectAccess = await getProjectAccess(authorization.identity!.authSubject, organizationId, projectId);
    if (!projectAccess || !canWriteProjectAccess(projectAccess)) return apiError("PROJECT_WRITE_REQUIRED", "你不能把素材导入这个目标项目。", 403);
    const entries = validateManifest(JSON.parse(manifestText)); const files = new Map<string, File>(); let totalBytes = 0;
    for (const value of form.getAll("media")) if (value instanceof File) { totalBytes += value.size; files.set(value.name, value); }
    if (totalBytes > MAX_IMPORT_BYTES) return apiError("MATERIAL_PACKAGE_TOO_LARGE", "单次导入包解压后不能超过 750 MB，请分批迁移。", 413);
    const user = await ensureUser(authorization.identity!); const db = getD1(); const bucket = getMediaBucket(); let imported = 0; let skipped = 0;
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== "object" || !rawEntry.video || !rawEntry.library) throw new Error("素材包中存在不完整的素材记录。");
      const sourceHash = cleanText(rawEntry.video.sourceHash, 128); const sourceUrl = cleanText(rawEntry.video.sourceUrl, 2_000);
      const duplicate = sourceHash
        ? await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_hash = ? AND deleted_at IS NULL LIMIT 1").bind(organizationId, projectId, sourceHash).first<{ id: string }>()
        : sourceUrl ? await db.prepare("SELECT id FROM videos WHERE organization_id = ? AND project_id = ? AND source_url = ? AND deleted_at IS NULL LIMIT 1").bind(organizationId, projectId, sourceUrl).first<{ id: string }>() : null;
      if (duplicate) { skipped += 1; continue; }
      const assets = Array.isArray(rawEntry.assets) ? rawEntry.assets : []; if (assets.length > MAX_ASSETS_PER_ENTRY) throw new Error(`单条素材最多携带 ${MAX_ASSETS_PER_ENTRY} 个媒体文件。`);
      const videoId = crypto.randomUUID(); const libraryEntryId = crypto.randomUUID(); const now = new Date().toISOString(); const entryKeys: string[] = []; const assetIds = new Map<string, string>();
      try {
        for (const rawAsset of assets) {
          const blobName = cleanText(rawAsset.blobName, 200, true); const file = blobName ? files.get(blobName) : undefined; if (!blobName || !file) throw new Error(`素材文件 ${blobName || "(未命名)"} 缺失。`);
          const bytes = await file.arrayBuffer(); const digest = await sha256Hex(bytes); if (rawAsset.sha256 && digest !== rawAsset.sha256) throw new Error(`素材文件 ${rawAsset.filename} 校验失败，迁移包可能不完整。`);
          const assetId = crypto.randomUUID(); const filename = cleanFilename(rawAsset.filename); const kind = cleanText(rawAsset.kind, 30, true); const contentType = cleanText(rawAsset.contentType, 120) || file.type || "application/octet-stream";
          if (!kind || !["source_video", "source_audio", "keyframe", "subtitle", "report"].includes(kind)) throw new Error("素材包包含不支持的媒体类型。");
          const r2Key = `organizations/${organizationId}/projects/${projectId}/videos/${videoId}/import/${assetId}-${filename}`;
          await bucket.put(r2Key, bytes, { httpMetadata: { contentType }, customMetadata: { organizationId, projectId, videoId, sha256: digest, imported: "true" } });
          entryKeys.push(r2Key); storedKeys.push(r2Key); assetIds.set(blobName, assetId);
          rawAsset.id = assetId; rawAsset.filename = filename; rawAsset.contentType = contentType; rawAsset.sizeBytes = bytes.byteLength; rawAsset.sha256 = digest; rawAsset.downloadUrl = r2Key;
        }
        const sourceMediaId = cleanText(rawEntry.video.sourceMediaBlobName, 200) ? assetIds.get(String(rawEntry.video.sourceMediaBlobName)) ?? null : null;
        const statements: D1PreparedStatement[] = [];
        statements.push(db.prepare("INSERT INTO videos (id, organization_id, project_id, social_account_id, media_asset_id, platform, source_type, source_url, source_hash, platform_work_id, title, author_name, published_at, duration_sec, status, error_message, created_by, updated_by, deleted_at, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, NULL, ?, ?)").bind(videoId, organizationId, projectId, rawEntry.video.platform === "upload" ? "upload" : "douyin", rawEntry.video.sourceType === "upload" ? "upload" : "url", sourceUrl || null, sourceHash || null, cleanText(rawEntry.video.platformWorkId, 200) || null, cleanText(rawEntry.video.title, 500) || null, cleanText(rawEntry.video.authorName, 300) || null, cleanText(rawEntry.video.publishedAt, 40) || null, asInteger(rawEntry.video.durationSec), user.id, user.id, now, now));
        for (const asset of assets) statements.push(db.prepare("INSERT INTO media_assets (id, organization_id, project_id, video_id, kind, r2_key, filename, content_type, size_bytes, sha256, status, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").bind(asset.id, organizationId, projectId, videoId, asset.kind, asset.downloadUrl, asset.filename, asset.contentType, asset.sizeBytes, asset.sha256, user.id, user.id, now, now));
        if (sourceMediaId) statements.push(db.prepare("UPDATE videos SET media_asset_id = ? WHERE id = ?").bind(sourceMediaId, videoId));
        for (const transcript of (Array.isArray(rawEntry.transcripts) ? rawEntry.transcripts : []).slice(0, 20)) statements.push(db.prepare("INSERT INTO video_transcripts (id, organization_id, project_id, video_id, version, language, source, full_text, segments_json, confidence, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, asInteger(transcript.version) || 1, cleanText(transcript.language, 40) || "zh-CN", transcript.source === "manual" ? "manual" : "asr", cleanText(transcript.full_text, 2_000_000) || "", cleanJson(transcript.segments_json, "[]"), asInteger(transcript.confidence), user.id, now, now));
        for (const analysis of (Array.isArray(rawEntry.analyses) ? rawEntry.analyses : []).slice(0, 20)) statements.push(db.prepare("INSERT INTO video_analyses (id, organization_id, project_id, video_id, schema_version, report_json, confidence, model_provider, model_name, prompt_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, cleanText(analysis.schema_version, 100) || "imported.v1", cleanJson(analysis.report_json, "{}"), asInteger(analysis.confidence), cleanText(analysis.model_provider, 100) || null, cleanText(analysis.model_name, 150) || null, cleanText(analysis.prompt_version, 150) || null, user.id, now, now));
        for (const metric of (Array.isArray(rawEntry.metrics) ? rawEntry.metrics : []).slice(0, 100)) statements.push(db.prepare("INSERT INTO video_metric_snapshots (id, organization_id, project_id, video_id, source, plays, likes, comments, favorites, shares, followers_gained, collected_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, ["public", "client_backend", "manual"].includes(String(metric.source)) ? metric.source : "manual", asInteger(metric.plays), asInteger(metric.likes), asInteger(metric.comments), asInteger(metric.favorites), asInteger(metric.shares), asInteger(metric.followers_gained), cleanText(metric.collected_at, 40) || now, user.id, now));
        statements.push(db.prepare("INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, input_transcript_id, source_type, source_ref, idempotency_key, status, analysis_profile, progress, current_stage, retry_count, attempt_count, version, resume_count, created_by, updated_by, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'completed', 'standard', 100, 'imported', 0, 0, 0, 0, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, videoId, rawEntry.video.sourceType === "upload" ? "upload" : "url", sourceUrl || `import:${videoId}`, `material-import:${crypto.randomUUID()}`, user.id, user.id, now, now, now));
        statements.push(db.prepare("INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, notes, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(libraryEntryId, organizationId, videoId, ["published", "benchmark", "industry", "case", "trend", "creative", "other"].includes(String(rawEntry.library.category)) ? rawEntry.library.category : "other", JSON.stringify(cleanStringList(rawEntry.library.tags, 12)), cleanText(rawEntry.library.notes, 1_000) || null, user.id, user.id, now, now));
        statements.push(db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video_library.imported', 'video_library_entry', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, libraryEntryId, JSON.stringify({ assetCount: assets.length }), now));
        await db.batch(statements); imported += 1; storedKeys = storedKeys.filter((key) => !entryKeys.includes(key));
      } catch (error) { await Promise.all(entryKeys.map((key) => bucket.delete(key).catch(() => undefined))); storedKeys = storedKeys.filter((key) => !entryKeys.includes(key)); throw error; }
    }
    return Response.json({ imported, skipped });
  } catch (error) { if (storedKeys.length) { const bucket = getMediaBucket(); await Promise.all(storedKeys.map((key) => bucket.delete(key).catch(() => undefined))); } return errorResponse(error); }
}
