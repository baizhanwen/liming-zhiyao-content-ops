UPDATE project_memory_items
SET status = 'expired',
    expires_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'candidate'
  AND source_type = 'project_assistant'
  AND EXISTS (
    SELECT 1
    FROM project_memory_events event
    WHERE event.id = project_memory_items.source_id
      AND event.organization_id = project_memory_items.organization_id
      AND event.project_id = project_memory_items.project_id
      AND event.source_type = 'video_analysis'
  );

UPDATE project_memory_events
SET status = 'pending',
    operation_summary_json = '[]',
    error_code = NULL,
    error_message = NULL,
    model_provider = NULL,
    model_name = NULL,
    prompt_version = NULL,
    processed_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE source_type = 'video_analysis'
  AND event_type = 'video_analysis_completed'
  AND id = (
    SELECT newest.id
    FROM project_memory_events newest
    WHERE newest.organization_id = project_memory_events.organization_id
      AND newest.project_id = project_memory_events.project_id
      AND newest.source_type = 'video_analysis'
      AND newest.source_id = project_memory_events.source_id
    ORDER BY newest.created_at DESC, newest.id DESC
    LIMIT 1
  )
  AND source_id IN (
    SELECT latest.id
    FROM project_video_references refs
    INNER JOIN video_library_entries library
      ON library.id = refs.library_entry_id
      AND library.organization_id = refs.organization_id
    INNER JOIN video_analyses latest ON latest.id = (
      SELECT candidate.id
      FROM video_analyses candidate
      WHERE candidate.organization_id = refs.organization_id
        AND candidate.video_id = library.source_video_id
      ORDER BY candidate.created_at DESC
      LIMIT 1
    )
    WHERE refs.organization_id = project_memory_events.organization_id
      AND refs.project_id = project_memory_events.project_id
      AND refs.purpose = 'benchmark'
      AND refs.status = 'active'
  );
