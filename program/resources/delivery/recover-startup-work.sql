-- Run only while the official startup holds the web and database-write gates.
-- Preserve drafts and request receipts; never dispatch a model or reset quotas.
WITH request_usage AS (
  SELECT organization_id, project_id,
    json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END, '$.runId') AS run_id,
    json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END, '$.usage.inputTokens') AS input_tokens,
    json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END, '$.usage.outputTokens') AS output_tokens,
    json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END, '$.usage.totalTokens') AS total_tokens,
    CASE WHEN json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END, '$.modelRequests[0].usageKnown') = 1 THEN 0 ELSE 1 END AS unknown_request
  FROM model_calls WHERE task_type LIKE 'script_rewrite_%'
)
UPDATE script_rewrite_runs AS r SET
  actual_input_tokens = COALESCE((SELECT SUM(CAST(input_tokens AS INTEGER)) FROM request_usage m WHERE m.run_id=r.id AND m.organization_id=r.organization_id AND m.project_id=r.project_id), 0),
  actual_output_tokens = COALESCE((SELECT SUM(CAST(output_tokens AS INTEGER)) FROM request_usage m WHERE m.run_id=r.id AND m.organization_id=r.organization_id AND m.project_id=r.project_id), 0),
  actual_total_tokens = COALESCE((SELECT SUM(CAST(total_tokens AS INTEGER)) FROM request_usage m WHERE m.run_id=r.id AND m.organization_id=r.organization_id AND m.project_id=r.project_id), 0),
  validation_json = json_set(CASE WHEN json_valid(validation_json) THEN validation_json ELSE '{}' END, '$.modelUsage.unknownRequestCount',
    COALESCE((SELECT SUM(unknown_request) FROM request_usage m WHERE m.run_id=r.id AND m.organization_id=r.organization_id AND m.project_id=r.project_id), 0)),
  status = 'failed', error_code = 'WEB_PROCESS_INTERRUPTED',
  error_message = '服务已重新启动，上次改写未完成。原有版本和已发生的调用保留；请核对用量后单独重试这一版。',
  completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status = 'started';

UPDATE ecommerce_generation_runs SET status='failed', error_code='WEB_PROCESS_INTERRUPTED',
  error_message='服务已重新启动，上次生成未完成。原稿和调用记录保留，未自动重试；请核对用量后重新生成。',
  completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='running';

UPDATE project_memory_events SET status='failed', error_code='WEB_PROCESS_INTERRUPTED',
  error_message='服务已重新启动，上次记忆提取未完成。来源保留；重新同步会发起新的模型请求，请先核对用量。',
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='processing';

UPDATE project_assistant_messages SET status='failed', error_code='WEB_PROCESS_INTERRUPTED',
  content='服务已重新启动，上次助理回复未完成。问题和调用记录保留；请核对用量后重新发送问题。'
WHERE role='assistant' AND status='processing';

UPDATE generation_source_manifests SET status='failed', error_code='WEB_PROCESS_INTERRUPTED',
  completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='started';

UPDATE model_calls SET status='failed', error_code='WEB_PROCESS_INTERRUPTED',
  error_message='服务已重新启动，该请求的最终结果未确认。调用额度和已收到的用量保留；缺失用量须与供应商核对。',
  completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='started';
