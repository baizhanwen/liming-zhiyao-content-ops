import { getD1, sha256Hex } from "../db/runtime";
import { extractVideoKnowledgeAtomsFromReport } from "./video-knowledge-atom-state";
import { ProjectWriteAccessChangedError, type ProjectWriteScope } from "./project-write-access";
import { assessAnalysisQuality } from "./analysis-quality";

function parse(value: string) { try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; } }
export async function extractVideoKnowledgeAtoms(input: { organizationId: string; videoId: string; analysisId: string; schemaVersion?: string; reportJson: string; reportHash?: string; extractorVersion?: string; now?: string; writeScope?: ProjectWriteScope; assertWriteAccess?: () => Promise<void> }) {
  const report = parse(input.reportJson);
  if (!report) return { status: "unsupported", count: 0 };
  const db = getD1();
  const persisted = await db.prepare("SELECT schema_version, report_json FROM video_analyses WHERE id=? AND organization_id=? AND video_id=?").bind(input.analysisId, input.organizationId, input.videoId).first<{ schema_version: string; report_json: string }>();
  if (!persisted || persisted.report_json !== input.reportJson) return { status: "stale", count: 0 };
  const schemaVersion = persisted.schema_version;
  if (input.schemaVersion && input.schemaVersion !== schemaVersion) return { status: "unsupported", count: 0 };
  if (!assessAnalysisQuality(schemaVersion, report).accepted) return { status: "unsupported", count: 0 };
  const library = await db.prepare("SELECT id FROM video_library_entries WHERE organization_id = ? AND source_video_id = ? LIMIT 1").bind(input.organizationId, input.videoId).first<{ id: string }>();
  if (!library) return { status: "unsupported", count: 0 };
  const reportHash = input.reportHash ?? await sha256Hex(new TextEncoder().encode(input.reportJson));
  return extractVideoKnowledgeAtomsFromReport(db, { organizationId: input.organizationId, libraryEntryId: library.id, analysisId: input.analysisId, report, reportHash, extractorVersion: input.extractorVersion ?? "atoms.v1", now: input.now ?? new Date().toISOString(), requireCurrentAnalysis: true, reportJson: input.reportJson, writeScope: input.writeScope, assertWriteAccess: input.assertWriteAccess });
}
export async function backfillProjectBenchmarkKnowledgeAtoms(input: { organizationId: string; projectId: string; limit?: number; userId?: string; assertWriteAccess?: () => Promise<void> }) {
  const db = getD1();
  const limit = Math.max(1, Math.min(100, input.limit ?? 100));
  const rows = await db.prepare(`
    SELECT library.source_video_id AS video_id, analysis.id AS analysis_id, analysis.schema_version, analysis.report_json
    FROM project_video_references refs
    INNER JOIN video_library_entries library
      ON library.id = refs.library_entry_id AND library.organization_id = refs.organization_id
    INNER JOIN video_analyses analysis ON analysis.id = (
      SELECT latest.id FROM video_analyses latest
      WHERE latest.organization_id = library.organization_id AND latest.video_id = library.source_video_id
      ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
    )
    WHERE refs.organization_id = ? AND refs.project_id = ?
      AND refs.purpose = 'benchmark' AND refs.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM video_knowledge_atoms atoms
        WHERE atoms.organization_id = refs.organization_id
          AND atoms.library_entry_id = refs.library_entry_id
          AND atoms.status = 'active'
      )
    ORDER BY refs.created_at ASC
    LIMIT ?
  `).bind(input.organizationId, input.projectId, limit).all<{ video_id: string; analysis_id: string; schema_version: string; report_json: string }>();
  let extracted = 0;
  let atomCount = 0;
  let failed = 0;
  for (const row of rows.results) {
    await input.assertWriteAccess?.();
    try {
      const result = await extractVideoKnowledgeAtoms({
        organizationId: input.organizationId,
        videoId: row.video_id,
        analysisId: row.analysis_id,
        schemaVersion: row.schema_version,
        reportJson: row.report_json,
        extractorVersion: "atoms.v2",
        writeScope: input.userId ? { organizationId: input.organizationId, projectId: input.projectId, userId: input.userId } : undefined,
        assertWriteAccess: input.assertWriteAccess,
      });
      if (result.status === "completed") {
        extracted += 1;
        atomCount += result.count;
      } else {
        failed += 1;
      }
    } catch (error) {
      if (error instanceof ProjectWriteAccessChangedError) throw error;
      failed += 1;
    }
  }
  return { attempted: rows.results.length, extracted, atomCount, failed };
}
