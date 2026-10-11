import { apiError } from "./api-response.ts";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition } from "./project-write-access.ts";

type Submission = {
  organizationId: string; projectId: string; userId: string; now: string;
  sourceType: "url" | "upload"; sourceHash: string; sourceUrl?: string; filename?: string;
};
type Database = Pick<D1Database, "prepare" | "batch">;

/** Reusing existing media never needs a running analyzer or consumes a new analysis quota. */
export async function resolveVideoSubmission(db: Database, input: Submission, validateNew: () => Promise<Response | null>, assertAccess?: () => Promise<void>) {
  const { organizationId, projectId, sourceHash, sourceUrl, sourceType, userId, now } = input;
  const duplicate = await db.prepare(`SELECT id FROM videos WHERE organization_id = ? AND project_id = ?
    AND (source_hash = ? OR (? IS NOT NULL AND source_url = ?)) AND deleted_at IS NULL`)
    .bind(organizationId, projectId, sourceHash, sourceUrl ?? null, sourceUrl ?? null).first<{ id: string }>();
  if (duplicate) return apiError("VIDEO_ALREADY_EXISTS", sourceType === "url" ? "该链接已经进入当前项目。" : "相同媒体已经进入当前项目。", 409, { videoId: duplicate.id });
  const canonical = await db.prepare(`
    SELECT library.id AS library_entry_id, v.id, v.platform, v.source_type, v.source_url, v.title, v.author_name, v.status, v.created_at, a.filename, a.size_bytes,
      job.id AS job_id, job.status AS job_status, job.progress, job.current_stage, job.error_code, job.error_message, job.retry_count, job.analysis_profile, job.created_at AS job_created_at, job.updated_at AS job_updated_at
    FROM video_library_entries library
    INNER JOIN videos v ON v.id = library.source_video_id AND v.organization_id = library.organization_id
    LEFT JOIN media_assets a ON a.id = v.media_asset_id
    LEFT JOIN analysis_jobs job ON job.id = (SELECT latest.id FROM analysis_jobs latest WHERE latest.organization_id = v.organization_id AND latest.video_id = v.id ORDER BY latest.created_at DESC LIMIT 1)
    WHERE library.organization_id = ? AND v.deleted_at IS NULL AND (v.source_hash = ? OR (? IS NOT NULL AND v.source_url = ?))
    LIMIT 1
  `).bind(organizationId, sourceHash, sourceUrl ?? null, sourceUrl ?? null).first<Record<string, unknown>>();
  if (!canonical) return validateNew();
  const libraryEntryId = String(canonical.library_entry_id);
  const existing = await db.prepare("SELECT id,status FROM project_video_references WHERE organization_id=? AND project_id=? AND library_entry_id=? AND purpose='analysis'").bind(organizationId, projectId, libraryEntryId).first<{ id: string; status: string }>();
  const reference = { id: existing?.id ?? crypto.randomUUID(), action: !existing ? "created" : existing.status === "revoked" ? "reactivated" : "already_active" };
  const origin = sourceType === "url" ? { sourceUrl } : { filename: input.filename };
  await assertAccess?.();
  const sourceCondition = "EXISTS (SELECT 1 FROM video_library_entries library INNER JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id WHERE library.id=? AND library.organization_id=? AND v.deleted_at IS NULL)";
  const results = await db.batch([
    db.prepare(`INSERT INTO project_video_references (id,organization_id,project_id,library_entry_id,purpose,status,created_by,created_at)
      SELECT ?,?,?,?,'analysis','active',?,? WHERE ${projectWriteAccessCondition} AND ${sourceCondition}
      ON CONFLICT(project_id,library_entry_id,purpose) DO UPDATE SET status='active',revoked_by=NULL,revoked_at=NULL,revoke_reason=NULL`)
      .bind(reference.id, organizationId, projectId, libraryEntryId, userId, now, ...projectWriteAccessBindings(input), libraryEntryId, organizationId),
    db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
      SELECT ?,?,?,?,'video.analysis_reused','video_library_entry',?,?,? WHERE ${projectWriteAccessCondition} AND ${sourceCondition}
      AND EXISTS(SELECT 1 FROM project_video_references WHERE organization_id=? AND project_id=? AND library_entry_id=? AND purpose='analysis' AND status='active')`)
      .bind(crypto.randomUUID(), organizationId, projectId, userId, libraryEntryId, JSON.stringify({ ...origin, sourceVideoId: canonical.id, referenceAction: reference.action }), now, ...projectWriteAccessBindings(input), libraryEntryId, organizationId, organizationId, projectId, libraryEntryId),
  ]);
  if (!results[0].meta.changes) {
    await assertProjectWriteAccess(db, input);
    return apiError("VIDEO_LIBRARY_SOURCE_CHANGED", "共享素材已删除或不可用，本次没有导入。请刷新素材库后再选择。", 409);
  }
  return Response.json({
    reused: true, referenceAction: reference.action,
    video: { id: canonical.id, platform: canonical.platform, source_type: canonical.source_type, title: canonical.title, author_name: canonical.author_name, status: canonical.status, created_at: canonical.created_at, is_reference: true, library_entry_id: canonical.library_entry_id,
      ...(sourceType === "url" ? { source_url: canonical.source_url } : { filename: canonical.filename, size_bytes: canonical.size_bytes }) },
    job: canonical.job_id
      ? { id: canonical.job_id, video_id: canonical.id, status: canonical.job_status, progress: canonical.progress, current_stage: canonical.current_stage, error_code: canonical.error_code, error_message: canonical.error_message, retry_count: canonical.retry_count, analysis_profile: canonical.analysis_profile, created_at: canonical.job_created_at, updated_at: canonical.job_updated_at }
      : { id: `reused-${canonical.id}`, video_id: canonical.id, status: canonical.status === "ready" ? "completed" : "pending", progress: canonical.status === "ready" ? 100 : 0, current_stage: "复用公司素材库分析", retry_count: 0, analysis_profile: "shared", created_at: canonical.created_at, updated_at: canonical.created_at },
  });
}

/** Returned statements join the caller's media transaction, so failures cannot leave half a submission. */
export function newVideoSubmissionStatements(db: Database, input: Submission & {
  videoId: string; jobId: string; title: string | null; mediaAssetId?: string;
  analysisProfile: string; auditMetadata: Record<string, unknown>;
}) {
  const { organizationId, projectId, videoId, jobId, userId, now, sourceType, sourceHash, analysisProfile } = input;
  const stage = sourceType === "url" ? "等待进入分析队列" : "媒体已入库，等待分析";
  const sourceRef = sourceType === "url" ? input.sourceUrl : input.mediaAssetId;
  if (!sourceRef) throw new Error("VIDEO_SOURCE_REQUIRED");
  const written = "EXISTS(SELECT 1 FROM videos WHERE id=? AND organization_id=? AND project_id=? AND created_by=?)";
  const writtenBindings = [videoId, organizationId, projectId, userId];
  return [
    db.prepare(`INSERT INTO videos (id, organization_id, project_id, media_asset_id, platform, source_type, source_url, source_hash, title, status, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ? WHERE ${projectWriteAccessCondition}`)
      .bind(videoId, organizationId, projectId, input.mediaAssetId ?? null, sourceType === "url" ? "douyin" : "upload", sourceType, input.sourceUrl ?? null, sourceHash, input.title, userId, userId, now, now, ...projectWriteAccessBindings(input)),
    db.prepare(`INSERT INTO video_library_entries (id, organization_id, source_video_id, category, tags_json, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, 'other', '[]', ?, ?, ?, ? WHERE ${written}`)
      .bind(crypto.randomUUID(), organizationId, videoId, userId, userId, now, now, ...writtenBindings),
    db.prepare(`INSERT INTO analysis_jobs (id, organization_id, project_id, video_id, source_type, source_ref, idempotency_key, status, analysis_profile, progress, current_stage, retry_count, created_by, updated_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, 0, ?, ?, ?, ? WHERE ${written}`)
      .bind(jobId, organizationId, projectId, videoId, sourceType, sourceRef, sourceHash, analysisProfile, stage, userId, userId, now, now, ...writtenBindings),
    db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'video', ?, ?, ? WHERE ${written}`)
      .bind(crypto.randomUUID(), organizationId, projectId, userId, sourceType === "url" ? "video.url_submitted" : "video.uploaded", videoId, JSON.stringify(input.auditMetadata), now, ...writtenBindings),
  ];
}
