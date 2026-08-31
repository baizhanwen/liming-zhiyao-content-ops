UPDATE project_memory_items
SET status = 'expired', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_type = 'project_assistant'
  AND status IN ('candidate', 'confirmed')
  AND source_id IN (
    SELECT event.id
    FROM project_memory_events event
    INNER JOIN video_analyses analysis
      ON analysis.id = event.source_id AND analysis.organization_id = event.organization_id
    WHERE event.source_type = 'video_analysis'
      AND NOT EXISTS (
        SELECT 1
        FROM video_library_entries library
        INNER JOIN project_video_references refs
          ON refs.library_entry_id = library.id AND refs.organization_id = library.organization_id
        WHERE library.organization_id = event.organization_id
          AND library.source_video_id = analysis.video_id
          AND refs.project_id = event.project_id
          AND refs.purpose = 'benchmark'
          AND refs.status = 'active'
      )
  );

INSERT OR IGNORE INTO project_memory_events (
  id, organization_id, project_id, event_type, source_type, source_id,
  dedupe_key, payload_json, payload_hash, status, operation_summary_json,
  attempt_count, created_by, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))), refs.organization_id, refs.project_id,
  'video_analysis_completed', 'video_analysis', analysis.id,
  'benchmark-video-analysis:' || refs.project_id || ':' || analysis.id || ':' || refs.id,
  json_object(
    'analysisId', analysis.id,
    'videoId', analysis.video_id,
    'schemaVersion', analysis.schema_version,
    'analysisCreatedAt', analysis.created_at,
    'benchmarkReferenceId', refs.id,
    'libraryEntryId', refs.library_entry_id
  ),
  lower(hex(randomblob(32))), 'pending', '[]', 0, refs.created_by,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM project_video_references refs
INNER JOIN video_library_entries library
  ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
INNER JOIN video_analyses analysis ON analysis.id = (
  SELECT latest.id
  FROM video_analyses latest
  WHERE latest.organization_id = library.organization_id
    AND latest.video_id = library.source_video_id
  ORDER BY latest.created_at DESC
  LIMIT 1
)
WHERE refs.purpose = 'benchmark' AND refs.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM project_memory_events existing
    WHERE existing.organization_id = refs.organization_id
      AND existing.project_id = refs.project_id
      AND existing.source_type = 'video_analysis'
      AND existing.source_id = analysis.id
  );
