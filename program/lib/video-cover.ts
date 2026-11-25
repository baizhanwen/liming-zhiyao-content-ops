// The platform thumbnail belongs to the work. Quality and the selected-cover
// flag rank generated keyframes when that thumbnail is unavailable.
export const videoCoverOrder = `
  (frame.kind = 'platform_cover') DESC,
  CASE WHEN frame.kind = 'platform_cover' THEN frame.created_at END DESC,
  frame.is_cover DESC, COALESCE(frame.quality_score, 0) DESC, frame.created_at ASC, frame.id ASC`;

export const videoCoverJoin = `
  LEFT JOIN media_assets cover ON cover.id = (
    SELECT frame.id FROM media_assets frame
    WHERE frame.organization_id = v.organization_id AND frame.project_id = v.project_id
      AND frame.video_id = v.id AND frame.kind IN ('platform_cover', 'keyframe') AND frame.status = 'active'
    ORDER BY ${videoCoverOrder} LIMIT 1
  )`;

export const videoCoverColumns = `cover.id AS cover_asset_id,
  CASE cover.kind WHEN 'platform_cover' THEN 'platform' WHEN 'keyframe' THEN 'keyframe' END AS cover_source,
  CASE WHEN cover.kind = 'platform_cover' THEN EXISTS (
    SELECT 1 FROM media_assets frame WHERE frame.organization_id = v.organization_id
      AND frame.project_id = v.project_id AND frame.video_id = v.id AND frame.kind = 'keyframe' AND frame.status = 'active'
  ) ELSE 0 END AS has_fallback_frame`;

export function libraryCoverUrl(entryId: unknown, organizationId: string, projectId?: string, source?: unknown) {
  if (typeof entryId !== "string" || !entryId) return null;
  const params = new URLSearchParams({ organizationId });
  if (projectId) params.set("projectId", projectId);
  if (source === "platform" || source === "keyframe") params.set("source", source);
  return `/api/video-library/${encodeURIComponent(entryId)}/cover?${params}`;
}

export function libraryCoverFields(row: Record<string, unknown>, entryId: unknown, organizationId: string, projectId?: string) {
  return {
    cover_url: row.cover_asset_id ? libraryCoverUrl(entryId, organizationId, projectId, row.cover_source) : null,
    fallback_cover_url: row.has_fallback_frame ? libraryCoverUrl(entryId, organizationId, projectId, "keyframe") : null,
    has_fallback_frame: undefined,
  };
}
