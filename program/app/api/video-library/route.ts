import { materialAnalysisColumns } from "../../../lib/material-analysis-state";
import { canAccessOrganizationVideoLibrary, canManageOrganizationVideoLibrary, ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";

// Same company-library policy as canManageOrganizationVideoLibrary, evaluated
// in the transaction so a revoked membership cannot authorize a stale request.
const libraryWriteAccess = `EXISTS(SELECT 1 FROM users u JOIN organization_members om ON om.user_id=u.id
  JOIN organizations o ON o.id=om.organization_id WHERE u.id=? AND o.id=? AND u.status='active'
  AND o.status='active' AND om.status='active' AND (om.role='admin' OR EXISTS(
    SELECT 1 FROM project_members pm JOIN projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
    WHERE pm.organization_id=o.id AND pm.user_id=u.id AND pm.status='active' AND p.deleted_at IS NULL AND p.status<>'archived')))`;

const categories = ["published", "benchmark", "industry", "case", "trend", "creative", "other"] as const;
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
        j.status AS job_status, j.progress AS job_progress, j.current_stage, ${materialAnalysisColumns},
        (SELECT COUNT(*) FROM project_video_references refs WHERE refs.organization_id = library.organization_id AND refs.library_entry_id = library.id AND refs.purpose = 'benchmark' AND refs.status = 'active') AS reference_count,
        CASE WHEN ? != '' AND EXISTS (
          SELECT 1 FROM project_video_references own_ref
          WHERE own_ref.organization_id = library.organization_id AND own_ref.project_id = ? AND own_ref.library_entry_id = library.id AND own_ref.purpose = 'benchmark' AND own_ref.status = 'active'
        ) THEN 1 ELSE 0 END AS imported_to_project,
        (SELECT frame.id FROM media_assets frame WHERE frame.organization_id = v.organization_id AND frame.project_id = v.project_id AND frame.video_id = v.id AND frame.kind = 'keyframe' AND frame.status = 'active' ORDER BY frame.is_cover DESC, COALESCE(frame.quality_score, 0) DESC, frame.created_at ASC LIMIT 1) AS cover_asset_id
      FROM video_library_entries library
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      INNER JOIN projects p ON p.id = v.project_id AND p.organization_id = v.organization_id
      LEFT JOIN video_analyses latest_analysis ON latest_analysis.id=(SELECT id FROM video_analyses WHERE organization_id=v.organization_id AND video_id=v.id ORDER BY created_at DESC LIMIT 1)
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
    const expectedUpdatedAt = typeof payload.expectedUpdatedAt === "string" ? payload.expectedUpdatedAt : "";
    const category = payload.category;
    const tags = parseTags(payload.tags);
    const notes = typeof payload.notes === "string" ? payload.notes.trim().slice(0, 1000) || null : null;
    if (!organizationId || !entryId) return apiError("LIBRARY_SCOPE_REQUIRED", "缺少公司或素材范围。", 400);
    if (!isCategory(category) || !tags) return apiError("INVALID_LIBRARY_METADATA", "素材分类或标签无效。", 400);
    if (!expectedUpdatedAt) return apiError("LIBRARY_VERSION_REQUIRED", "请刷新素材列表后再保存分类和标签。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || !await canManageOrganizationVideoLibrary(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能整理公司素材库。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    if ((await readRequestIdentity(request))?.authSubject !== identity.authSubject) return apiError("WRITE_ACCESS_REQUIRED", "登录状态已改变，本次素材修改未保存。请刷新后重试。", 403);
    const marker = crypto.randomUUID();
    const result = await db.batch<{ updated_at: string }>([
      db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
        SELECT ?,?,NULL,?,'video_library.updated','video_library_entry',?,?,? WHERE ${libraryWriteAccess}
        AND EXISTS(SELECT 1 FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id
          WHERE library.id=? AND library.organization_id=? AND library.updated_at=? AND v.deleted_at IS NULL)`)
        .bind(marker, organizationId, user.id, entryId, JSON.stringify({ category, tags }), now, user.id, organizationId, entryId, organizationId, expectedUpdatedAt),
      db.prepare(`UPDATE video_library_entries SET category=?,tags_json=?,notes=?,updated_by=?,updated_at=CASE WHEN updated_at>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ',julianday(updated_at)+1.0/86400000) ELSE ? END
        WHERE id=? AND organization_id=? AND EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
        .bind(category, JSON.stringify(tags), notes, user.id, now, now, entryId, organizationId, marker),
      db.prepare("SELECT updated_at FROM video_library_entries WHERE id=? AND organization_id=?").bind(entryId, organizationId),
    ]);
    if (!result[0].meta.changes) {
      if (!await db.prepare(`SELECT 1 WHERE ${libraryWriteAccess}`).bind(user.id, organizationId).first()) return apiError("WRITE_ACCESS_REQUIRED", "公司或项目权限已改变，本次素材修改未保存。请刷新后重试。", 403);
      if (await db.prepare(`SELECT 1 FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id
        WHERE library.id=? AND library.organization_id=? AND v.deleted_at IS NULL`).bind(entryId, organizationId).first()) return apiError("LIBRARY_VERSION_CONFLICT", "其他成员已修改这条素材，本次未覆盖。请先复制当前标签，再刷新核对后保存。", 409);
      return apiError("LIBRARY_ENTRY_NOT_FOUND", "素材或源视频已删除，请刷新素材列表。", 404);
    }
    return Response.json({ entry: { id: entryId, category, tags, notes, updated_at: result[2].results[0]?.updated_at } });
  } catch (error) { return errorResponse(error); }
}
