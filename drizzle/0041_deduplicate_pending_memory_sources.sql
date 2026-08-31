UPDATE project_memory_events
SET status = 'completed',
    operation_summary_json = '[{"operation":"noop","canonicalKey":null,"outcome":"noop","confidence":0,"reason":"同一分析结果已有新的待处理事件，本次去重保留历史记录。"}]',
    error_code = NULL,
    error_message = NULL,
    model_provider = 'system',
    model_name = 'memory-event-deduplicator',
    prompt_version = 'project-assistant.v5',
    processed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE source_type = 'video_analysis'
  AND event_type = 'video_analysis_completed'
  AND status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM project_memory_events newer
    WHERE newer.organization_id = project_memory_events.organization_id
      AND newer.project_id = project_memory_events.project_id
      AND newer.source_type = project_memory_events.source_type
      AND newer.source_id = project_memory_events.source_id
      AND newer.status = 'pending'
      AND (
        newer.created_at > project_memory_events.created_at
        OR (newer.created_at = project_memory_events.created_at AND newer.id > project_memory_events.id)
      )
  );
