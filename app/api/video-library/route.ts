import { canAccessOrganizationVideoLibrary, canManageOrganizationVideoLibrary, ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

const categories = ["benchmark", "industry", "case", "trend", "creative", "other"] as const;
type Category = typeof categories[number];

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && categories.includes(value as Category);
}

function parseTags(value: unknown) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 30)] : []))].slice(0, 12);
}

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问素材中心。", 401);
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
  const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const platform = url.searchParams.get("platform")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim() ?? "";
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  if (category && !isCategory(category)) return apiError("INVALID_LIBRARY_CATEGORY", "素材分类无效。", 400);
  if (platform && !["douyin", "upload"].includes(platform)) return apiError("INVALID_PLATFORM", "素材平台无效。", 400);
  if (status && !["pending", "processing", "ready", "failed", "archived"].includes(status)) return apiError("INVALID_VIDEO_STATUS", "素材状态无效。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || !await canAccessOrganizationVideoLibrary(access)) return apiError("ACCESS_DENIED", "当前角色不能浏览公司素材库。", 403);
    const db = getD1();
    const clauses = ["library.organization_id = ?", "v.deleted_at IS NULL"];
    const bindings: unknown[] = [organizationId];
    if (q) {
      clauses.push("(COALESCE(v.title, '') LIKE ? OR COALESCE(v.author_name, '') LIKE ? OR COALESCE(a.display_name, '') LIKE ? OR COALESCE(library.tags_json, '') LIKE ? OR COALESCE(p.name, '') LIKE ?)");
      const term = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      bindings.push(term, term, term, term, term);
    }
    if (category) { clauses.push("library.category = ?"); bindings.push(category); }
    if (platform) { clauses.push("v.platform = ?"); bindings.push(platform); }
    if (status) { clauses.push("v.status = ?"); bindings.push(status); }
    const rows = await db.prepare(`
      SELECT library.id, library.category, library.tags_json, library.notes, library.created_at, library.updated_at,
        v.id AS video_id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.published_at, v.duration_sec, v.status,
        p.id AS source_project_id, p.name AS source_project_name, a.display_name AS account_name,
        j.status AS job_status, j.progress AS job_progress, j.current_stage,
        (SELECT COUNT(*) FROM project_video_references refs WHERE refs.organization_id = library.organization_id AND refs.library_entry_id = library.id AND refs.purpose = 'benchmark') AS reference_count,
        CASE WHEN ? != '' AND EXISTS (
          SELECT 1 FROM project_video_references own_ref
          WHERE own_ref.organization_id = library.organization_id AND own_ref.project_id = ? AND own_ref.library_entry_id = library.id AND own_ref.purpose = 'benchmark'
        ) THEN 1 ELSE 0 END AS imported_to_project,
        (SELECT frame.id FROM media_assets frame WHERE frame.organization_id = v.organization_id AND frame.project_id = v.project_id AND frame.video_id = v.id AND frame.kind = 'keyframe' AND frame.status = 'active' ORDER BY frame.is_cover DESC, COALESCE(frame.quality_score, 0) DESC, frame.created_at ASC LIMIT 1) AS cover_asset_id
      FROM video_library_entries library
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      INNER JOIN projects p ON p.id = v.project_id AND p.organization_id = v.organization_id
      LEFT JOIN social_accounts a ON a.id = v.social_account_id
      LEFT JOIN analysis_jobs j ON j.id = (
        SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1
      )
      WHERE ${clauses.join(" AND ")}
      ORDER BY library.updated_at DESC
      LIMIT 300
    `).bind(projectId, projectId, ...bindings).all<Record<string, unknown>>();
    const canManage = await canManageOrganizationVideoLibrary(access);
    return Response.json({
      entries: rows.results.map((row) => ({
        ...row,
        tags: (() => { try { return JSON.parse(String(row.tags_json ?? "[]")); } catch { return []; } })(),
        tags_json: undefined,
        cover_url: row.cover_asset_id ? `/api/video-library/${row.id}/cover?organizationId=${encodeURIComponent(organizationId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}` : null,
      })),
      canManage,
    });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再整理素材。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = typeof payload.organizationId === "string" ? payload.organizationId.trim() : "";
    const entryId = typeof payload.entryId === "string" ? payload.entryId.trim() : "";
    const category = payload.category;
    const tags = parseTags(payload.tags);
    const notes = typeof payload.notes === "string" ? payload.notes.trim().slice(0, 1000) || null : null;
    if (!organizationId || !entryId) return apiError("LIBRARY_SCOPE_REQUIRED", "缺少公司或素材范围。", 400);
    if (!isCategory(category) || !tags) return apiError("INVALID_LIBRARY_METADATA", "素材分类或标签无效。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || !await canManageOrganizationVideoLibrary(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能整理公司素材库。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const result = await db.prepare("UPDATE video_library_entries SET category = ?, tags_json = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ?").bind(category, JSON.stringify(tags), notes, user.id, now, entryId, organizationId).run();
    if (!result.meta.changes) return apiError("LIBRARY_ENTRY_NOT_FOUND", "素材不存在。", 404);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, NULL, ?, 'video_library.updated', 'video_library_entry', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, user.id, entryId, JSON.stringify({ category, tags }), now).run();
    return Response.json({ entry: { id: entryId, category, tags, notes, updated_at: now } });
  } catch (error) { return errorResponse(error); }
}
