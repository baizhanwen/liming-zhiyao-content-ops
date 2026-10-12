import { apiError } from "./api-response";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access";
import { prepareProjectMemoryEventWithDb, type ProjectAssistantDatabase } from "./project-memory-events";

type Snapshot = { entryId: string; id: string; status: string | null; revokedAt: string | null; creator: string; analysisId: string | null; videoId: string; schemaVersion: string | null; analysisCreatedAt: string | null };

/** The first audit statement is a guarded transaction marker. Every dependent
 * reference/event checks that marker; any database failure rolls the batch back. */
export async function importBenchmarkReferences(db: D1Database, scope: ProjectWriteScope, entryIds: string[], assertAccess: () => Promise<void>) {
  const rows = await db.prepare(`SELECT library.id,library.source_video_id AS video_id,refs.id AS reference_id,refs.status,refs.revoked_at,refs.created_by,
      analysis.id AS analysis_id,analysis.schema_version,analysis.created_at AS analysis_created_at
    FROM video_library_entries library JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id AND v.deleted_at IS NULL
    LEFT JOIN project_video_references refs ON refs.organization_id=library.organization_id AND refs.project_id=? AND refs.library_entry_id=library.id AND refs.purpose='benchmark'
    LEFT JOIN video_analyses analysis ON analysis.id=(SELECT id FROM video_analyses WHERE organization_id=library.organization_id AND video_id=library.source_video_id ORDER BY created_at DESC LIMIT 1)
    WHERE library.organization_id=? AND library.id IN (SELECT value FROM json_each(?))`).bind(scope.projectId, scope.organizationId, JSON.stringify(entryIds)).all<Record<string, unknown>>();
  if (rows.results.length !== entryIds.length) return apiError("LIBRARY_ENTRY_NOT_FOUND", "所选素材已删除、不存在或不属于当前公司，本批未导入。请刷新后重新选择。", 404);
  const snapshots: Snapshot[] = entryIds.map(entryId => {
    const row = rows.results.find(row => row.id === entryId)!;
    return { entryId, id: row.reference_id ? String(row.reference_id) : crypto.randomUUID(), status: row.status ? String(row.status) : null, revokedAt: row.revoked_at ? String(row.revoked_at) : null, creator: row.created_by ? String(row.created_by) : scope.userId,
      analysisId: row.analysis_id ? String(row.analysis_id) : null, videoId: String(row.video_id), schemaVersion: row.schema_version ? String(row.schema_version) : null, analysisCreatedAt: row.analysis_created_at ? String(row.analysis_created_at) : null };
  });
  const actions = snapshots.map(s => ({ id: s.id, action: !s.status ? "created" : s.status === "revoked" ? "reactivated" : "already_active" }));
  const marker = crypto.randomUUID(), now = new Date().toISOString(), stateJson = JSON.stringify(snapshots);
  const markerExists = "EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND organization_id=? AND project_id=? AND actor_user_id=? AND action='video_library.imported')";
  const markerBindings = [marker, scope.organizationId, scope.projectId, scope.userId];
  const statements = [db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
    SELECT ?,?,?,?,'video_library.imported','project',?,?,? WHERE ${projectWriteAccessCondition}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted
      LEFT JOIN video_library_entries library ON library.id=json_extract(wanted.value,'$.entryId') AND library.organization_id=?
      LEFT JOIN videos v ON v.id=library.source_video_id AND v.organization_id=library.organization_id AND v.deleted_at IS NULL
      LEFT JOIN project_video_references refs ON refs.organization_id=library.organization_id AND refs.project_id=? AND refs.library_entry_id=library.id AND refs.purpose='benchmark'
      WHERE v.id IS NULL OR library.source_video_id IS NOT json_extract(wanted.value,'$.videoId') OR
        (json_extract(wanted.value,'$.status') IS NULL AND refs.id IS NOT NULL) OR
        (json_extract(wanted.value,'$.status') IS NOT NULL AND (refs.id IS NOT json_extract(wanted.value,'$.id') OR refs.status IS NOT json_extract(wanted.value,'$.status') OR refs.revoked_at IS NOT json_extract(wanted.value,'$.revokedAt'))) OR
        (SELECT id FROM video_analyses WHERE organization_id=library.organization_id AND video_id=library.source_video_id ORDER BY created_at DESC LIMIT 1) IS NOT json_extract(wanted.value,'$.analysisId'))`)
    .bind(marker, scope.organizationId, scope.projectId, scope.userId, scope.projectId, JSON.stringify({ entryIds, actions }), now, ...projectWriteAccessBindings(scope), stateJson, scope.organizationId, scope.projectId)];
  for (const snapshot of snapshots) {
    statements.push(db.prepare(`INSERT INTO project_video_references(id,organization_id,project_id,library_entry_id,purpose,status,created_by,created_at)
      SELECT ?,?,?,?,'benchmark','active',?,? WHERE ${markerExists}
      ON CONFLICT(project_id,library_entry_id,purpose) DO UPDATE SET status='active',revoked_by=NULL,revoked_at=NULL,revoke_reason=NULL`)
      .bind(snapshot.id, scope.organizationId, scope.projectId, snapshot.entryId, scope.userId, now, ...markerBindings));
    if (snapshot.analysisId) {
      const event = await prepareProjectMemoryEventWithDb(db as unknown as ProjectAssistantDatabase, { ...scope, userId: snapshot.creator, eventType: "video_analysis_completed", sourceType: "video_analysis", sourceId: snapshot.analysisId,
        payload: { analysisId: snapshot.analysisId, videoId: snapshot.videoId, schemaVersion: snapshot.schemaVersion, analysisCreatedAt: snapshot.analysisCreatedAt, benchmarkReferenceId: snapshot.id, libraryEntryId: snapshot.entryId } }, { sql: markerExists, bindings: markerBindings });
      statements.push(event.statement as D1PreparedStatement);
    }
  }
  await assertAccess();
  const results = await db.batch(statements);
  if (!results[0].meta.changes) { await assertProjectWriteAccess(db, scope); return apiError("LIBRARY_IMPORT_CHANGED", "素材或导入状态已被其他成员改变，本批未导入。请刷新后重新选择。", 409); }
  return Response.json({ imported: entryIds.length, entryIds, actions }, { status: 201 });
}

export async function removeBenchmarkReference(db: D1Database, scope: ProjectWriteScope, referenceId: string, assertAccess: () => Promise<void>) {
  const marker = crypto.randomUUID(), now = new Date().toISOString();
  await assertAccess();
  const results = await db.batch([
    db.prepare(`INSERT INTO audit_logs(id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?,?,'video_library.removed','project_video_reference',?,?,? WHERE ${projectWriteAccessCondition}
      AND EXISTS(SELECT 1 FROM project_video_references WHERE id=? AND organization_id=? AND project_id=? AND purpose='benchmark' AND status='active')`)
      .bind(marker, scope.organizationId, scope.projectId, scope.userId, referenceId, JSON.stringify({ projectId: scope.projectId }), now, ...projectWriteAccessBindings(scope), referenceId, scope.organizationId, scope.projectId),
    db.prepare(`UPDATE project_video_references SET status='revoked',revoked_by=?,revoked_at=?,revoke_reason='manual'
      WHERE id=? AND organization_id=? AND project_id=? AND purpose='benchmark' AND status='active' AND EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
      .bind(scope.userId, now, referenceId, scope.organizationId, scope.projectId, marker),
  ]);
  if (!results[0].meta.changes) { await assertProjectWriteAccess(db, scope); return apiError("LIBRARY_REFERENCE_NOT_FOUND", "该对标素材已经不在当前项目中，请刷新核对。", 404); }
  return Response.json({ removed: referenceId });
}
