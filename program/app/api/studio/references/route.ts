import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { readReferenceStructure, StructureDraftError, structureVideoScopeSql } from "../../../../lib/structure-draft";

export const dynamic = "force-dynamic";

type ReferenceRow = {
  videoId: string; analysisId: string; title: string; author: string | null; analyzedAt: string; libraryEntryId: string | null;
};
const pageSize = 12;

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录。", 401);
  const params = new URL(request.url).searchParams;
  const organizationId = params.get("organizationId")?.trim();
  const projectId = params.get("projectId")?.trim();
  if (!organizationId || !projectId) return apiError("PROJECT_SCOPE_REQUIRED", "请选择企业空间。", 400);
  const search = (params.get("search") || "").trim().slice(0, 200);
  const page = Number(params.get("page") || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) return apiError("INVALID_PAGE", "页码无效。", 400);
  try {
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权查看这个空间的参考视频。", 403);
    const db = getD1();
    const rows = await db.prepare(`
      SELECT v.id AS videoId, COALESCE(NULLIF(v.title,''), m.filename, '未命名视频') AS title,
        v.author_name AS author, a.id AS analysisId, a.created_at AS analyzedAt,
        (SELECT l.id FROM video_library_entries l JOIN project_video_references r
          ON r.organization_id=l.organization_id AND r.library_entry_id=l.id
          WHERE v.project_id<>? AND l.organization_id=v.organization_id AND l.source_video_id=v.id
            AND r.project_id=? AND r.status='active' AND r.purpose='benchmark' LIMIT 1) AS libraryEntryId
      FROM videos v
      JOIN video_analyses a ON a.id=(SELECT latest.id FROM video_analyses latest
        WHERE latest.organization_id=v.organization_id AND latest.project_id=v.project_id AND latest.video_id=v.id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)
      LEFT JOIN media_assets m ON m.id=v.media_asset_id AND m.organization_id=v.organization_id AND m.project_id=v.project_id
      WHERE v.organization_id=? AND v.deleted_at IS NULL AND ${structureVideoScopeSql}
        AND (?='' OR instr(lower(COALESCE(v.title,'') || ' ' || COALESCE(m.filename,'') || ' ' || COALESCE(v.author_name,'')), lower(?))>0)
      ORDER BY a.created_at DESC, v.id LIMIT ? OFFSET ?
    `).bind(projectId, projectId, organizationId, projectId, projectId, search, search, pageSize + 1, (page - 1) * pageSize).all<ReferenceRow>();
    const videos = await Promise.all(rows.results.slice(0, pageSize).map(async row => {
      try {
        const structure = await readReferenceStructure(db, { organizationId, projectId, videoId: row.videoId,
          analysisId: row.analysisId, libraryEntryId: row.libraryEntryId || undefined });
        return { ...row, segmentCount: structure.segments.length, unavailableReason: null };
      } catch (reason) {
        if (!(reason instanceof StructureDraftError)) throw reason;
        return { ...row, segmentCount: 0, unavailableReason: reason.message };
      }
    }));
    return Response.json({ videos, hasNext: rows.results.length > pageSize, canWrite: canWriteProjectAccess(access) });
  } catch (error) { return errorResponse(error); }
}
