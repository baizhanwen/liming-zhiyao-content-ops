import {
  enqueueProjectMemoryEventWithDb,
  type ProjectAssistantDatabase,
} from "./project-memory-events.ts";

type AnalysisRow = {
  id: string;
  video_id: string;
  schema_version: string;
  created_at: string;
};

type BenchmarkReferenceRow = {
  reference_id: string;
  project_id: string;
  library_entry_id: string;
  created_by: string;
};

export async function enqueueBenchmarkVideoAnalysisMemoryEventsWithDb(
  db: ProjectAssistantDatabase,
  input: {
    organizationId: string;
    analysisId?: string;
    videoId?: string;
    libraryEntryId?: string;
    targetProjectId?: string;
  },
) {
  let analysis: AnalysisRow | null | undefined;
  if (input.analysisId) {
    analysis = await db.prepare(
      "SELECT id, video_id, schema_version, created_at FROM video_analyses WHERE id = ? AND organization_id = ? LIMIT 1",
    ).bind(input.analysisId, input.organizationId).first<AnalysisRow>();
  } else if (input.libraryEntryId) {
    analysis = await db.prepare(`
      SELECT analysis.id, analysis.video_id, analysis.schema_version, analysis.created_at
      FROM video_library_entries library
      INNER JOIN video_analyses analysis ON analysis.id = (
        SELECT latest.id FROM video_analyses latest
        WHERE latest.organization_id = library.organization_id AND latest.video_id = library.source_video_id
        ORDER BY latest.created_at DESC LIMIT 1
      )
      WHERE library.id = ? AND library.organization_id = ?
      LIMIT 1
    `).bind(input.libraryEntryId, input.organizationId).first<AnalysisRow>();
  } else if (input.videoId) {
    analysis = await db.prepare(
      "SELECT id, video_id, schema_version, created_at FROM video_analyses WHERE organization_id = ? AND video_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(input.organizationId, input.videoId).first<AnalysisRow>();
  }
  if (!analysis) return { analysisId: null, created: 0, references: 0 };

  const projectClause = input.targetProjectId ? " AND refs.project_id = ?" : "";
  const bindings = [input.organizationId, analysis.video_id];
  if (input.targetProjectId) bindings.push(input.targetProjectId);
  const references = await db.prepare(`
    SELECT refs.id AS reference_id, refs.project_id, refs.library_entry_id, refs.created_by
    FROM project_video_references refs
    INNER JOIN video_library_entries library
      ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
    WHERE refs.organization_id = ? AND library.source_video_id = ?
      AND refs.purpose = 'benchmark' AND refs.status = 'active'${projectClause}
    ORDER BY refs.project_id, refs.created_at
  `).bind(...bindings).all<BenchmarkReferenceRow>();

  let created = 0;
  for (const reference of references.results) {
    const queued = await enqueueProjectMemoryEventWithDb(db, {
      organizationId: input.organizationId,
      projectId: reference.project_id,
      userId: reference.created_by,
      eventType: "video_analysis_completed",
      sourceType: "video_analysis",
      sourceId: analysis.id,
      payload: {
        analysisId: analysis.id,
        videoId: analysis.video_id,
        schemaVersion: analysis.schema_version,
        analysisCreatedAt: analysis.created_at,
        benchmarkReferenceId: reference.reference_id,
        libraryEntryId: reference.library_entry_id,
      },
    });
    if (queued.created) created += 1;
  }
  return { analysisId: analysis.id, created, references: references.results.length };
}
