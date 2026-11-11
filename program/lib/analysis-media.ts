type MediaRow = { id: string; r2_key: string; filename: string; content_type: string; size_bytes: number };
export async function readScopedAnalysisMedia(db: D1Database, scope: { organizationId: string; projectId: string; videoId: string }, analysisId?: string | null) {
  let jobId: string | null = null;
  if (analysisId) {
    const analysis = await db.prepare("SELECT analysis_job_id FROM video_analyses WHERE id=? AND organization_id=? AND project_id=? AND video_id=?")
      .bind(analysisId, scope.organizationId, scope.projectId, scope.videoId).first<{ analysis_job_id: string | null }>();
    if (!analysis) return { analysisFound: false, media: null, binding: null } as const;
    jobId = analysis.analysis_job_id;
  }
  if (jobId) {
    const media = await db.prepare(`SELECT a.id,a.r2_key,a.filename,a.content_type,a.size_bytes FROM media_assets a
      INNER JOIN videos v ON v.id=a.video_id AND v.organization_id=a.organization_id AND v.project_id=a.project_id
      WHERE v.id=? AND v.organization_id=? AND v.project_id=? AND v.deleted_at IS NULL
        AND a.analysis_job_id=? AND a.kind IN ('source_video','source_audio') AND a.status='active'
      ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`).bind(scope.videoId, scope.organizationId, scope.projectId, jobId).first<MediaRow>();
    if (media) return { analysisFound: true, media, binding: "analysis" } as const;
  }
  const media = await db.prepare(`SELECT a.id,a.r2_key,a.filename,a.content_type,a.size_bytes FROM videos v
    INNER JOIN media_assets a ON a.id=v.media_asset_id AND a.organization_id=v.organization_id AND a.project_id=v.project_id
      AND (a.video_id IS NULL OR a.video_id=v.id) AND a.status='active' AND a.kind IN ('source_video','source_audio')
    WHERE v.id=? AND v.organization_id=? AND v.project_id=? AND v.deleted_at IS NULL`).bind(scope.videoId, scope.organizationId, scope.projectId).first<MediaRow>();
  return { analysisFound: true, media, binding: media ? "video" : null } as const;
}
