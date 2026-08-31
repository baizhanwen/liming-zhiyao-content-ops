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
  AND status = 'completed'
  AND COALESCE(prompt_version, '') <> 'project-assistant.v5';
