export type VideoKnowledgeAtomSourceRow = {
  id: unknown;
  atom_key: unknown;
  atom_type: unknown;
  title: unknown;
  content: unknown;
  structured_json: unknown;
  source_locator_json: unknown;
  confidence: unknown;
  report_hash: unknown;
  extractor_version: unknown;
  status: unknown;
  superseded_by: unknown;
  analysis_id: unknown;
  analysis_created_at: unknown;
  video_id: unknown;
  project_id: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function parseJson(value: unknown) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function serializeVideoKnowledgeAtom(row: VideoKnowledgeAtomSourceRow) {
  return {
    id: String(row.id),
    atomKey: String(row.atom_key),
    atomType: String(row.atom_type),
    title: String(row.title),
    content: String(row.content),
    structured: parseJson(row.structured_json),
    sourceLocator: parseJson(row.source_locator_json),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    reportHash: String(row.report_hash),
    extractorVersion: String(row.extractor_version),
    status: String(row.status),
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
    source: {
      type: "video_analysis",
      analysisId: String(row.analysis_id),
      videoId: String(row.video_id),
      projectId: String(row.project_id),
      analyzedAt: String(row.analysis_created_at),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}