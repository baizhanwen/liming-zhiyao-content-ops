import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition, type ProjectWriteScope } from "./project-write-access.ts";
import { readUnifiedReport, projectSafeAnalysisReport } from "./unified-report.ts";
import { readContentAnalysis } from "./video-content-analysis.ts";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T>(): Promise<T | null | undefined>;
  all<T>(): Promise<{ results: T[] }>;
};
type Database = {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<{ meta?: { changes?: number } }[]>;
};

const atomFields = ["summary", "hook", "structure", "audience", "highlights", "risks", "recommendations", "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve", "conversion_design"] as const;
function values(value: unknown) {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [item.trim()].filter(Boolean) : item && typeof item === "object" ? [JSON.stringify(item)] : []);
  return value && typeof value === "object" ? [JSON.stringify(value)] : [];
}

export async function extractVideoKnowledgeAtomsFromReport(db: Database, input: { organizationId: string; libraryEntryId: string; analysisId: string; report: Record<string, unknown>; reportHash: string; extractorVersion: string; now: string; requireCurrentAnalysis?: boolean; reportJson?: string; writeScope?: ProjectWriteScope; assertWriteAccess?: () => Promise<void> }) {
  const unified = readUnifiedReport(input.report);
  const safeReport = projectSafeAnalysisReport(input.report);
  if (!safeReport) return { status: "unsupported", count: 0, libraryEntryId: input.libraryEntryId };
  const registry = new Map((unified ? readContentAnalysis(input.report)?.evidence_registry : [])?.map(row => [row.id, row]) ?? []);
  const findings = unified?.sections.flatMap(section => section.findings) ?? [];
  const reportEvidence = values(safeReport.evidence);
  const atomInputs = atomFields.flatMap((field) => values(safeReport[field]).map((item, index) => {
    const evidence = reportEvidence.find((quote) => item.includes(quote) || quote.includes(item));
    const linked = findings.filter(finding => finding.text === item || item.includes(finding.text));
    const evidenceIds = [...new Set(linked.flatMap(finding => finding.evidence_ids))];
    const sources = evidenceIds.flatMap(id => registry.has(id) ? [registry.get(id)!] : []);
    const locator = linked.length ? {
      version: "unified-finding-source.v1", finding_ids: linked.map(finding => finding.id), evidence_ids: evidenceIds,
      evidence: sources.find(source => source.text)?.text ?? null,
      sources: sources.map(source => ({ id: source.id, source: source.source, start_ms: source.start_ms, end_ms: source.end_ms, asset_ref: source.asset_ref })),
    } : { evidence: evidence ?? null };
    return { field, index, item, locator };
  }));
  if (!atomInputs.length) return { status: "unsupported", count: 0, libraryEntryId: input.libraryEntryId };
  const atoms = atomInputs.map(({ field, index, item, locator }) => ({
    id: crypto.randomUUID(),
    atomKey: field + ":" + index,
    atomType: field,
    title: field + " · " + (index + 1),
    content: item,
    structuredJson: JSON.stringify({ field, index }),
    sourceLocatorJson: JSON.stringify(locator),
  }));
  await input.assertWriteAccess?.();
  if (input.writeScope) await assertProjectWriteAccess(db, input.writeScope);
  const sourceCondition = `EXISTS (SELECT 1 FROM video_analyses a
    INNER JOIN video_library_entries library ON library.source_video_id=a.video_id AND library.organization_id=a.organization_id
    INNER JOIN videos v ON v.id=a.video_id AND v.organization_id=a.organization_id AND v.deleted_at IS NULL
    WHERE a.id=? AND a.organization_id=? AND a.report_json=? AND library.id=?
      AND a.id=(SELECT latest.id FROM video_analyses latest WHERE latest.organization_id=a.organization_id AND latest.video_id=a.video_id ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1))`;
  const referenceCondition = "EXISTS (SELECT 1 FROM project_video_references WHERE organization_id=? AND project_id=? AND library_entry_id=? AND purpose='benchmark' AND status='active')";
  const currentCondition = [input.requireCurrentAnalysis ? sourceCondition : null, input.writeScope ? referenceCondition : null].filter(Boolean).join(" AND ");
  const currentBindings = [...(input.requireCurrentAnalysis ? [input.analysisId, input.organizationId, input.reportJson ?? JSON.stringify(input.report), input.libraryEntryId] : []), ...(input.writeScope ? [input.writeScope.organizationId, input.writeScope.projectId, input.libraryEntryId] : [])];
  const sourceIsCurrent = async () => !currentCondition || Boolean(await db.prepare(`SELECT 1 WHERE ${currentCondition}`).bind(...currentBindings).first());
  if (!await sourceIsCurrent()) return { status: "stale", count: 0, libraryEntryId: input.libraryEntryId };
  type AtomRow = { id: string; atom_key: string; analysis_id: string; report_hash: string; extractor_version: string };
  const readActive = () => db.prepare("SELECT id, atom_key, analysis_id, report_hash, extractor_version FROM video_knowledge_atoms WHERE organization_id = ? AND library_entry_id = ? AND status = 'active'").bind(input.organizationId, input.libraryEntryId).all<AtomRow>();
  const matches = (rows: AtomRow[]) => rows.length === atoms.length && rows.every(row => row.analysis_id === input.analysisId && row.report_hash === input.reportHash && row.extractor_version === input.extractorVersion && atoms.some(atom => atom.atomKey === row.atom_key));
  const completed = () => ({ status: "completed", count: atoms.length, libraryEntryId: input.libraryEntryId });
  const old = await readActive();
  if (matches(old.results)) return { ...completed(), reused: true };
  const nextIdByKey = new Map(atoms.map((atom) => [atom.atomKey, atom.id]));
  const snapshotCondition = `(SELECT COUNT(*) FROM video_knowledge_atoms WHERE organization_id=? AND library_entry_id=? AND status='active')=?
    AND NOT EXISTS (SELECT 1 FROM video_knowledge_atoms WHERE organization_id=? AND library_entry_id=? AND status='active' AND id NOT IN (SELECT value FROM json_each(?)))
    AND NOT EXISTS (SELECT 1 FROM video_knowledge_atoms WHERE analysis_id=? AND atom_key IN (SELECT value FROM json_each(?)))`;
  const initialCondition = `${snapshotCondition}${currentCondition ? ` AND ${currentCondition}` : ""}${input.writeScope ? ` AND ${projectWriteAccessCondition}` : ""}`;
  const initialBindings = [input.organizationId, input.libraryEntryId, old.results.length, input.organizationId, input.libraryEntryId, JSON.stringify(old.results.map(row => row.id)), input.analysisId, JSON.stringify(atoms.map(atom => atom.atomKey)), ...currentBindings, ...(input.writeScope ? projectWriteAccessBindings(input.writeScope) : [])];
  const writtenCondition = "EXISTS (SELECT 1 FROM video_knowledge_atoms WHERE id=? AND organization_id=? AND library_entry_id=?)";
  const writtenBindings = [atoms[0].id, input.organizationId, input.libraryEntryId];
  const writes = atoms.map((atom, index) => db.prepare(`INSERT INTO video_knowledge_atoms (id, organization_id, library_entry_id, analysis_id, atom_key, atom_type, title, content, structured_json, source_locator_json, confidence, report_hash, extractor_version, status, superseded_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ? WHERE ${index === 0 ? initialCondition : writtenCondition}`).bind(atom.id, input.organizationId, input.libraryEntryId, input.analysisId, atom.atomKey, atom.atomType, atom.title, atom.content, atom.structuredJson, atom.sourceLocatorJson, Number(input.report.confidence ?? 0) || null, input.reportHash, input.extractorVersion, input.now, input.now, ...(index === 0 ? initialBindings : writtenBindings)));
  for (const previous of old.results) writes.push(db.prepare(`UPDATE video_knowledge_atoms SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND library_entry_id = ? AND status = 'active' AND ${writtenCondition}`).bind(nextIdByKey.get(previous.atom_key) ?? null, input.now, previous.id, input.organizationId, input.libraryEntryId, ...writtenBindings));
  await input.assertWriteAccess?.();
  const results = await db.batch(writes);
  if (!results[0]?.meta?.changes) {
    await input.assertWriteAccess?.();
    if (input.writeScope) await assertProjectWriteAccess(db, input.writeScope);
    if (!await sourceIsCurrent()) return { status: "stale", count: 0, libraryEntryId: input.libraryEntryId };
    if (matches((await readActive()).results)) return { ...completed(), reused: true };
    return { status: "conflict", count: 0, libraryEntryId: input.libraryEntryId };
  }
  return completed();
}
