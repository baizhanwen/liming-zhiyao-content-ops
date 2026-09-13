import { getD1 } from "../../db/runtime";
import { EcommerceError, type EcommerceAccess } from "./access";

export const normalizedQuote = (text: string) => text.replace(/\s+/g, "");
export function quoteLocated(quote: string, source: string) {
  const value = normalizedQuote(quote);
  return value.length > 0 && normalizedQuote(source).includes(value);
}

export async function readCaseSource(access: EcommerceAccess, referenceId: string, analysisId: string, transcriptId: string | null) {
  const db = getD1();
  const source = await db.prepare(`SELECT r.id AS reference_id,v.id AS video_id,a.report_json,a.id AS analysis_id,v.title
    FROM project_video_references r
    INNER JOIN video_library_entries l ON l.id=r.library_entry_id AND l.organization_id=r.organization_id
    INNER JOIN videos v ON v.id=l.source_video_id AND v.organization_id=l.organization_id
    INNER JOIN video_analyses a ON a.video_id=v.id AND a.organization_id=v.organization_id
    WHERE r.id=? AND r.organization_id=? AND r.project_id=? AND r.purpose='benchmark' AND r.status='active' AND v.deleted_at IS NULL AND v.status!='archived' AND a.id=?`)
    .bind(referenceId, access.organizationId, access.projectId, analysisId).first<{ reference_id: string; video_id: string; report_json: string; analysis_id: string; title: string }>();
  if (!source) throw new EcommerceError("CASE_SOURCE_UNAVAILABLE", "对标引用或分析版本不可用。", 409);
  // Preserve only text nodes of the actual report; JSON keys cannot serve as quoted evidence.
  const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  let reportText: string;
  try { reportText = strings(JSON.parse(source.report_json)).join("\n"); } catch { throw new EcommerceError("INVALID_CASE_REPORT", "对标分析格式无效，请重新分析。", 409); }
  let transcriptText = "";
  if (transcriptId) {
    const row = await db.prepare("SELECT full_text FROM video_transcripts WHERE id=? AND video_id=? AND organization_id=?")
      .bind(transcriptId, source.video_id, access.organizationId).first<{ full_text: string }>();
    if (!row) throw new EcommerceError("TRANSCRIPT_UNAVAILABLE", "转写不属于该对标视频。", 409);
    transcriptText = row.full_text;
  }
  return { ...source, sourceText: [reportText, transcriptText].filter(Boolean).join("\n") };
}
