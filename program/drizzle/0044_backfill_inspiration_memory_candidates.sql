INSERT INTO project_memory_items (
  id, organization_id, project_id, canonical_key, category, kind, status,
  title, content, value_json, source_type, source_id, revision, content_hash,
  created_by, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  card.organization_id,
  card.project_id,
  'inspiration/' || substr(card.canonical_key, 1, 148),
  'memory',
  'soft',
  'candidate',
  card.title,
  card.core_insight,
  json_object(
    'inspirationCardId', card.id,
    'applicableScenarios', json(card.applicable_scenarios_json),
    'excludedScenarios', json(card.excluded_scenarios_json),
    'tags', json(card.tags_json),
    'confidence', card.confidence
  ),
  'inspiration_card',
  card.id,
  COALESCE((
    SELECT MAX(existing.revision)
    FROM project_memory_items existing
    WHERE existing.organization_id = card.organization_id
      AND existing.project_id = card.project_id
      AND existing.canonical_key = 'inspiration/' || substr(card.canonical_key, 1, 148)
  ), 0) + 1,
  card.content_hash,
  card.created_by,
  card.created_at,
  card.updated_at
FROM project_inspiration_cards card
WHERE card.status IN ('candidate', 'confirmed')
  AND card.source_type = 'project_assistant'
  AND card.version = (
    SELECT MAX(latest.version)
    FROM project_inspiration_cards latest
    WHERE latest.organization_id = card.organization_id
      AND latest.project_id = card.project_id
      AND latest.canonical_key = card.canonical_key
      AND latest.status IN ('candidate', 'confirmed')
  )
  AND NOT EXISTS (
    SELECT 1 FROM project_memory_items existing
    WHERE existing.organization_id = card.organization_id
      AND existing.project_id = card.project_id
      AND existing.source_type = 'inspiration_card'
      AND existing.source_id = card.id
  );
--> statement-breakpoint
INSERT INTO project_memory_evidence (
  id, organization_id, project_id, memory_item_id, source_type, source_id,
  quote, relevance, created_by, created_at
)
SELECT
  lower(hex(randomblob(16))),
  memory.organization_id,
  memory.project_id,
  memory.id,
  'inspiration_card',
  card.id,
  substr(card.core_insight, 1, 4000),
  100,
  card.created_by,
  card.created_at
FROM project_memory_items memory
INNER JOIN project_inspiration_cards card
  ON card.organization_id = memory.organization_id
  AND card.project_id = memory.project_id
  AND card.id = memory.source_id
WHERE memory.source_type = 'inspiration_card'
  AND NOT EXISTS (
    SELECT 1 FROM project_memory_evidence evidence
    WHERE evidence.organization_id = memory.organization_id
      AND evidence.project_id = memory.project_id
      AND evidence.memory_item_id = memory.id
      AND evidence.source_type = 'inspiration_card'
      AND evidence.source_id = card.id
  );
