-- Preserve the user's selection separately from legacy auto-expanded citations.
ALTER TABLE topic_ideas ADD COLUMN selected_knowledge_ids_json TEXT NOT NULL DEFAULT '[]';

UPDATE topic_ideas
SET selected_knowledge_ids_json = COALESCE((
  SELECT CASE
    WHEN json_type(a.metadata_json, '$.sourceKnowledgeItemIds') = 'array'
      THEN json_extract(a.metadata_json, '$.sourceKnowledgeItemIds')
    WHEN json_type(a.metadata_json, '$.sourceKnowledgeItemId') = 'text'
      AND length(json_extract(a.metadata_json, '$.sourceKnowledgeItemId')) > 0
      THEN json_array(json_extract(a.metadata_json, '$.sourceKnowledgeItemId'))
    ELSE '[]'
  END
  FROM audit_logs a
  WHERE a.organization_id = topic_ideas.organization_id
    AND a.project_id = topic_ideas.project_id
    AND a.target_id = topic_ideas.id
    AND a.action = 'topic.created'
    AND json_valid(a.metadata_json)
  ORDER BY a.created_at DESC, a.id DESC LIMIT 1
), '[]');
