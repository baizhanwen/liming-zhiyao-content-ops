import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问对标内容库。", 401);
  const url = new URL(request.url); const organizationId = url.searchParams.get("organizationId")?.trim() ?? ""; const projectId = url.searchParams.get("projectId")?.trim() ?? "";
  const q = url.searchParams.get("q")?.trim().slice(0, 100) ?? ""; const category = url.searchParams.get("category")?.trim() ?? "";
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司或项目范围。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目的对标内容库。", 403);
    const clauses = ["refs.organization_id = ?", "refs.project_id = ?", "refs.purpose = 'benchmark'", "v.deleted_at IS NULL"];
    const bindings: unknown[] = [organizationId, projectId];
    if (q) { const term = `%${q}%`; clauses.push("(COALESCE(v.title, '') LIKE ? OR COALESCE(v.author_name, '') LIKE ? OR COALESCE(library.tags_json, '') LIKE ?)"); bindings.push(term, term, term); }
    if (category) { clauses.push("library.category = ?"); bindings.push(category); }
    const rows = await getD1().prepare(`
      SELECT refs.id AS reference_id, refs.created_at AS imported_at, library.id, library.category, library.tags_json, library.notes,
        v.id AS video_id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.duration_sec, v.status,
        p.name AS source_project_name, account.display_name AS account_name,
        j.status AS job_status, j.progress AS job_progress, j.current_stage,
        (SELECT frame.id FROM media_assets frame WHERE frame.organization_id = v.organization_id AND frame.project_id = v.project_id AND frame.video_id = v.id AND frame.kind = 'keyframe' AND frame.status = 'active' ORDER BY frame.created_at ASC LIMIT 1) AS cover_asset_id
      FROM project_video_references refs
      INNER JOIN video_library_entries library ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
      INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
      INNER JOIN projects p ON p.id = v.project_id
      LEFT JOIN social_accounts account ON account.id = v.social_account_id
      LEFT JOIN analysis_jobs j ON j.id = (SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1)
      WHERE ${clauses.join(" AND ")}
      ORDER BY refs.created_at DESC LIMIT 300
    `).bind(...bindings).all<Record<string, unknown>>();
    return Response.json({
      entries: rows.results.map((row) => ({
        ...row,
        tags: (() => { try { return JSON.parse(String(row.tags_json ?? "[]")); } catch { return []; } })(),
        tags_json: undefined,
        cover_url: row.cover_asset_id ? `/api/video-library/${row.id}/cover?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(projectId)}` : null,
      })),
      canWrite: canWriteProjectAccess(access),
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再导入对标素材。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; entryIds?: unknown };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? "";
    const entryIds = Array.isArray(payload.entryIds) ? [...new Set(payload.entryIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))].slice(0, 100) : [];
    if (!organizationId || !projectId || !entryIds.length) return apiError("LIBRARY_IMPORT_REQUIRED", "请选择要导入的素材和目标项目。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能向项目导入对标素材。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const placeholders = entryIds.map(() => "?").join(",");
    const existing = await db.prepare(`SELECT id FROM video_library_entries WHERE organization_id = ? AND id IN (${placeholders})`).bind(organizationId, ...entryIds).all<{ id: string }>();
    const validIds = existing.results.map((row) => row.id);
    if (!validIds.length) return apiError("LIBRARY_ENTRY_NOT_FOUND", "所选素材不存在或不属于当前公司。", 404);
    await db.batch([
      ...validIds.map((entryId) => db.prepare("INSERT OR IGNORE INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, created_by, created_at) VALUES (?, ?, ?, ?, 'benchmark', ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, entryId, user.id, now)),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video_library.imported', 'project', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, projectId, JSON.stringify({ entryIds: validIds }), now),
    ]);
    return Response.json({ imported: validIds.length, entryIds: validIds }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再移出对标素材。", 401);
  try {
    const payload = await request.json() as { organizationId?: string; projectId?: string; referenceId?: string };
    const organizationId = payload.organizationId?.trim() ?? ""; const projectId = payload.projectId?.trim() ?? ""; const referenceId = payload.referenceId?.trim() ?? "";
    if (!organizationId || !projectId || !referenceId) return apiError("LIBRARY_REFERENCE_REQUIRED", "缺少对标素材范围。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能移出项目对标素材。", 403);
    const user = await ensureUser(identity); const db = getD1(); const now = new Date().toISOString();
    const result = await db.prepare("DELETE FROM project_video_references WHERE id = ? AND organization_id = ? AND project_id = ? AND purpose = 'benchmark'").bind(referenceId, organizationId, projectId).run();
    if (!result.meta.changes) return apiError("LIBRARY_REFERENCE_NOT_FOUND", "该对标素材已经不在当前项目中。", 404);
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'video_library.removed', 'project_video_reference', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, referenceId, JSON.stringify({ projectId }), now).run();
    return Response.json({ removed: referenceId });
  } catch (error) { return errorResponse(error); }
}
