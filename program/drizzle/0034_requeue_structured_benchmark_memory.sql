-- Re-run legacy benchmark analysis events after the structured eight-category
-- project-memory migration. Old memory rows stay expired for audit history.
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
  AND status = 'completed'
  AND COALESCE(prompt_version, '') <> 'project-assistant.v3'
  AND EXISTS (
    SELECT 1
    FROM video_analyses analysis
    INNER JOIN video_library_entries library
      ON library.organization_id = analysis.organization_id
      AND library.source_video_id = analysis.video_id
    INNER JOIN project_video_references refs
      ON refs.organization_id = library.organization_id
      AND refs.library_entry_id = library.id
      AND refs.project_id = project_memory_events.project_id
      AND refs.purpose = 'benchmark'
      AND refs.status = 'active'
    WHERE analysis.id = project_memory_events.source_id
      AND analysis.organization_id = project_memory_events.organization_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM project_memory_items memory
    WHERE memory.organization_id = project_memory_events.organization_id
      AND memory.project_id = project_memory_events.project_id
      AND memory.source_id = project_memory_events.id
      AND memory.category IS NOT NULL
      AND memory.status IN ('candidate', 'confirmed')
  );
