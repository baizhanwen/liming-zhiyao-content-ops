UPDATE project_memory_events
SET status = 'completed',
    operation_summary_json = '[{"operation":"noop","canonicalKey":null,"outcome":"noop","confidence":0,"reason":"同一对标视频已有更新的分析结果，本次保留历史记录但不重复提取候选。"}]',
    error_code = NULL,
    error_message = NULL,
    model_provider = 'system',
    model_name = 'latest-benchmark-analysis',
    prompt_version = 'project-assistant.v5',
    processed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE source_type = 'video_analysis'
  AND event_type = 'video_analysis_completed'
  AND status = 'pending'
  AND source_id NOT IN (
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
