/**
 * Evaluated in the same SQL statement that advances the version pointer.
 * `expected` is a CTE with one JSON `doc` column holding the public generation input.
 * Rechecking only in JS leaves a race between source validation and D1.batch.
 */
export const generationSourceGuard = `EXISTS (SELECT 1 FROM expected x WHERE
  EXISTS (SELECT 1 FROM ecommerce_products p JOIN ecommerce_product_versions pv ON pv.product_id=p.id AND pv.organization_id=p.organization_id AND pv.project_id=p.project_id
    WHERE p.id=json_extract(x.doc,'$.product.id') AND p.organization_id=ecommerce_tasks.organization_id AND p.project_id=ecommerce_tasks.project_id
    AND p.revision=json_extract(x.doc,'$.product.revision') AND p.status='confirmed' AND pv.id=json_extract(x.doc,'$.product.versionId') AND pv.confirmed_by IS NOT NULL
    AND (json_extract(x.doc,'$.virtualProductSnapshot.versionId') IS NULL OR (pv.id=json_extract(x.doc,'$.virtualProductSnapshot.versionId')
      AND pv.version=p.current_version AND pv.public_json=json_extract(x.doc,'$.virtualProductSnapshot.publicJson') AND pv.name=json_extract(x.doc,'$.virtualProductSnapshot.name'))))
  AND (json_extract(x.doc,'$.product.claim.validUntil') IS NULL OR julianday(json_extract(x.doc,'$.product.claim.validUntil')) > julianday('now'))
  AND (json_extract(x.doc,'$.product.offer.validUntil') IS NULL OR julianday(json_extract(x.doc,'$.product.offer.validUntil')) > julianday('now'))
  AND NOT EXISTS (SELECT 1 FROM json_each(x.doc,'$.evidence') e WHERE NOT (
    (json_extract(e.value,'$.virtualProductVersionId') IS NOT NULL
      AND json_extract(e.value,'$.virtualProductVersionId')=json_extract(x.doc,'$.virtualProductSnapshot.versionId')
      AND json_extract(e.value,'$.id')='product-facts:' || json_extract(x.doc,'$.virtualProductSnapshot.versionId')
      AND json_extract(e.value,'$.revision')=json_extract(x.doc,'$.product.revision'))
    OR (json_extract(e.value,'$.virtualProductVersionId') IS NULL AND EXISTS (
      SELECT 1 FROM ecommerce_evidence d WHERE d.id=json_extract(e.value,'$.id') AND d.revision=json_extract(e.value,'$.revision')
      AND d.organization_id=ecommerce_tasks.organization_id AND d.project_id=ecommerce_tasks.project_id AND d.product_id=ecommerce_tasks.product_id
      AND d.status='confirmed' AND d.confirmed_by IS NOT NULL AND (d.valid_until IS NULL OR julianday(d.valid_until)>julianday('now'))
      AND (d.media_asset_id IS NULL OR EXISTS(SELECT 1 FROM media_assets m WHERE m.id=d.media_asset_id AND m.organization_id=d.organization_id AND m.project_id=d.project_id AND m.status='active'))))
  ))
  AND NOT EXISTS (SELECT 1 FROM json_each(x.doc,'$.candidates') c WHERE NOT EXISTS (
    SELECT 1 FROM ecommerce_components d JOIN ecommerce_component_versions v ON v.component_id=d.id AND v.version=d.current_version
    WHERE d.id=json_extract(c.value,'$.id') AND d.revision=json_extract(c.value,'$.revision') AND v.id=json_extract(c.value,'$.versionId') AND d.status='confirmed'
    AND ((d.scope='project' AND d.organization_id=ecommerce_tasks.organization_id AND d.project_id=ecommerce_tasks.project_id) OR d.scope='system')
    AND (json_extract(v.body_json,'$.validUntil') IS NULL OR julianday(json_extract(v.body_json,'$.validUntil'))>julianday('now'))))
  AND NOT EXISTS (SELECT 1 FROM json_each(x.doc,'$.knowledge') k WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_items d JOIN knowledge_item_versions v ON v.item_id=d.id AND v.organization_id=d.organization_id AND v.project_id=d.project_id
    WHERE d.id=json_extract(k.value,'$.id') AND d.organization_id=ecommerce_tasks.organization_id AND d.project_id=ecommerce_tasks.project_id
    AND d.status='confirmed' AND d.deleted_at IS NULL AND v.id=json_extract(k.value,'$.versionId')
    AND NOT EXISTS(SELECT 1 FROM knowledge_item_versions newer WHERE newer.item_id=d.id AND newer.organization_id=d.organization_id AND newer.project_id=d.project_id AND newer.version>v.version)))
  AND NOT EXISTS (SELECT 1 FROM json_each(x.doc,'$.cases') c WHERE NOT (
    (coalesce(json_extract(c.value,'$.direct'),0)=0 AND EXISTS (
      SELECT 1 FROM ecommerce_case_profiles d JOIN project_video_references r ON r.id=d.reference_id AND r.organization_id=d.organization_id AND r.project_id=d.project_id
      JOIN videos v ON v.id=d.video_id AND v.organization_id=d.organization_id AND v.deleted_at IS NULL AND v.status!='archived'
      WHERE d.id=json_extract(c.value,'$.id') AND d.revision=json_extract(c.value,'$.revision') AND d.analysis_id=json_extract(c.value,'$.analysisId')
      AND d.organization_id=ecommerce_tasks.organization_id AND d.project_id=ecommerce_tasks.project_id AND d.status='confirmed' AND r.status='active' AND r.purpose='benchmark'))
    OR (json_extract(c.value,'$.direct')=1 AND EXISTS (
      SELECT 1 FROM project_video_references r
      JOIN video_library_entries l ON l.id=r.library_entry_id AND l.organization_id=r.organization_id
      JOIN videos v ON v.id=l.source_video_id AND v.organization_id=l.organization_id AND v.deleted_at IS NULL AND v.status!='archived'
      JOIN video_analyses a ON a.video_id=v.id AND a.organization_id=v.organization_id
      JOIN json_each(x.doc,'$.directCaseSnapshots') proof ON json_extract(proof.value,'$.id')=r.id
      WHERE r.id=json_extract(c.value,'$.referenceId') AND r.organization_id=ecommerce_tasks.organization_id AND r.project_id=ecommerce_tasks.project_id
      AND r.status='active' AND r.purpose='benchmark' AND a.id=json_extract(c.value,'$.analysisId')
      AND v.id=json_extract(proof.value,'$.videoId') AND a.report_json=json_extract(proof.value,'$.reportJson')
      AND (json_extract(proof.value,'$.transcriptId') IS NULL OR EXISTS (
        SELECT 1 FROM video_transcripts t WHERE t.id=json_extract(proof.value,'$.transcriptId') AND t.video_id=v.id AND t.organization_id=v.organization_id
        AND t.full_text=json_extract(proof.value,'$.transcriptText'))))
  )))
  AND (
    (json_extract(x.doc,'$.strategy.id') IS NULL AND (
      (json_extract(x.doc,'$.optionalStrategySnapshot.id') IS NULL AND NOT EXISTS (
        SELECT 1 FROM content_strategies s WHERE s.organization_id=ecommerce_tasks.organization_id AND s.project_id=ecommerce_tasks.project_id AND s.status='active'))
      OR EXISTS (SELECT 1 FROM content_strategies s WHERE s.id=json_extract(x.doc,'$.optionalStrategySnapshot.id')
        AND s.organization_id=ecommerce_tasks.organization_id AND s.project_id=ecommerce_tasks.project_id AND s.status='active'
        AND substr(coalesce(s.positioning,''),1,2000)=json_extract(x.doc,'$.optionalStrategySnapshot.positioning')
        AND substr(coalesce(s.target_audience,''),1,1000)=json_extract(x.doc,'$.optionalStrategySnapshot.targetAudience')
        AND substr(coalesce(s.style_notes,''),1,2000)=json_extract(x.doc,'$.optionalStrategySnapshot.styleNotes')
        AND NOT EXISTS(SELECT 1 FROM content_strategies newer WHERE newer.organization_id=s.organization_id AND newer.project_id=s.project_id AND newer.status='active' AND newer.version>s.version))
    ))
    OR EXISTS (SELECT 1 FROM content_strategies s WHERE s.id=json_extract(x.doc,'$.strategy.id') AND s.organization_id=ecommerce_tasks.organization_id AND s.project_id=ecommerce_tasks.project_id AND s.status='active'
      AND substr(coalesce(s.positioning,''),1,2000)=json_extract(x.doc,'$.strategy.positioning')
      AND substr(coalesce(s.target_audience,''),1,1000)=json_extract(x.doc,'$.strategy.targetAudience')
      AND substr(coalesce(s.style_notes,''),1,2000)=json_extract(x.doc,'$.strategy.styleNotes')
      AND NOT EXISTS(SELECT 1 FROM content_strategies newer WHERE newer.organization_id=s.organization_id AND newer.project_id=s.project_id AND newer.status='active' AND newer.version>s.version))
  )
)`;

/** Read permissions again in the final write transaction, including removal during a model call. */
export const generationActorGuard = `EXISTS(SELECT 1 FROM users u
  JOIN organization_members om ON om.user_id=u.id AND om.organization_id=ecommerce_tasks.organization_id AND om.status='active'
  JOIN organizations o ON o.id=om.organization_id AND o.status='active'
  JOIN projects p ON p.id=ecommerce_tasks.project_id AND p.organization_id=o.id AND p.deleted_at IS NULL AND p.status!='archived'
  WHERE u.id=? AND u.status='active' AND (om.role='admin' OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.organization_id=o.id AND pm.project_id=p.id AND pm.user_id=u.id AND pm.status='active' AND pm.role IS NOT NULL)))`;
