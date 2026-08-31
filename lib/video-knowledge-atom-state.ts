type Prepared = {
  bind(...values: unknown[]): Prepared;
  all<T>(): Promise<{ results: T[] }>;
};
type Database = {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<unknown>;
};

const atomFields = ["summary", "hook", "structure", "audience", "highlights", "risks", "recommendations", "hook_analysis", "viral_points", "rhythm_analysis", "emotion_curve", "conversion_design"] as const;
function values(value: unknown) {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [item.trim()].filter(Boolean) : item && typeof item === "object" ? [JSON.stringify(item)] : []);
  return value && typeof value === "object" ? [JSON.stringify(value)] : [];
}

export async function extractVideoKnowledgeAtomsFromReport(db: Database, input: { organizationId: string; libraryEntryId: string; analysisId: string; report: Record<string, unknown>; reportHash: string; extractorVersion: string; now: string }) {
  const reportEvidence = values(input.report.evidence);
  const atomInputs = atomFields.flatMap((field) => values(input.report[field]).map((item, index) => {
    const evidence = reportEvidence.find((quote) => item.includes(quote) || quote.includes(item));
    return { field, index, item, evidence };
  }));
  if (!atomInputs.length) return { status: "unsupported", count: 0, libraryEntryId: input.libraryEntryId };
  const atoms = atomInputs.map(({ field, index, item, evidence }) => ({
    id: crypto.randomUUID(),
    atomKey: field + ":" + index,
    atomType: field,
    title: field + " · " + (index + 1),
    content: item,
    structuredJson: JSON.stringify({ field, index }),
    sourceLocatorJson: JSON.stringify({ evidence: evidence ?? null }),
  }));
  const old = await db.prepare("SELECT id, atom_key FROM video_knowledge_atoms WHERE organization_id = ? AND library_entry_id = ? AND status = 'active'").bind(input.organizationId, input.libraryEntryId).all<{ id: string; atom_key: string }>();
  const nextIdByKey = new Map(atoms.map((atom) => [atom.atomKey, atom.id]));
  const writes = atoms.map((atom) => db.prepare("INSERT INTO video_knowledge_atoms (id, organization_id, library_entry_id, analysis_id, atom_key, atom_type, title, content, structured_json, source_locator_json, confidence, report_hash, extractor_version, status, superseded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)").bind(atom.id, input.organizationId, input.libraryEntryId, input.analysisId, atom.atomKey, atom.atomType, atom.title, atom.content, atom.structuredJson, atom.sourceLocatorJson, Number(input.report.confidence ?? 0) || null, input.reportHash, input.extractorVersion, input.now, input.now));
  for (const previous of old.results) writes.push(db.prepare("UPDATE video_knowledge_atoms SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND library_entry_id = ? AND status = 'active'").bind(nextIdByKey.get(previous.atom_key) ?? null, input.now, previous.id, input.organizationId, input.libraryEntryId));
  await db.batch(writes);
  return { status: "completed", count: atoms.length, libraryEntryId: input.libraryEntryId };
}