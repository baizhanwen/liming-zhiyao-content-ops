export type ScriptSegment = { startMs: number; endMs: number; text: string };
export type Manuscript = { basis: "audio" | "manual"; segments: ScriptSegment[]; originals: ScriptSegment[] };
type Asset = { id: string; analysis_job_id: string | null; kind: string; filename: string; created_at: string; url: string };
type AnalysisVersion = { created_at: string; analysis_job_id: string | null };
type StoredTranscript = { source: string; created_at: string; segments: unknown };

export function manuscriptAssetForVersion<T extends Omit<Asset, "url">>(assets: T[], analysis: AnalysisVersion | null, pinned: boolean) {
  return assets.filter(row => {
    if (row.kind !== "subtitle" || row.filename !== "manuscript.json") return false;
    const bound = Boolean(row.analysis_job_id && row.analysis_job_id === analysis?.analysis_job_id);
    if (pinned) return bound && row.created_at <= analysis!.created_at;
    return !analysis || bound || row.created_at > analysis.created_at;
  }).at(-1);
}

export function prefersStoredManuscript(transcript: StoredTranscript | null, asset: Asset | undefined, analysis: AnalysisVersion | null, pinned: boolean) {
  if (!transcript || pinned) return false;
  if (transcript.source === "manual") return !asset || transcript.created_at >= asset.created_at;
  return !asset && (!analysis || transcript.created_at > analysis.created_at);
}

export function parseManuscript(value: unknown): Manuscript {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== "manuscript.v1"
      || !("basis" in value) || (value.basis !== "audio" && value.basis !== "manual")
      || !("segments" in value) || !Array.isArray(value.segments) || !value.segments.length) throw new Error("口播稿格式无效。");
  const evidence = "subtitle_evidence" in value && value.subtitle_evidence && typeof value.subtitle_evidence === "object"
    ? value.subtitle_evidence as Record<string, unknown> : {};
  let previousStart = -1;
  const originals: ScriptSegment[] = [];
  const segments = value.segments.map((row, index) => {
    if (!row || typeof row.text !== "string" || !row.text.trim() || !Number.isSafeInteger(row.start_ms)
        || !Number.isSafeInteger(row.end_ms) || row.start_ms < 0 || row.start_ms < previousStart || row.end_ms < row.start_ms)
      throw new Error("口播稿分段或时间无效。");
    previousStart = row.start_ms;
    const segment = { startMs: row.start_ms, endMs: row.end_ms, text: row.text.trim() };
    const proof = evidence[`transcript:${String(index + 1).padStart(4, "0")}`];
    if (typeof row.original_text === "string" && row.original_text.trim()) {
      originals.push({ ...segment, text: row.original_text });
    } else if (proof && typeof proof === "object" && "source_text" in proof && typeof proof.source_text === "string" && proof.source_text.trim()) {
      originals.push({ ...segment, text: proof.source_text });
    } else originals.push(segment);
    return segment;
  });
  return { basis: value.basis, segments, originals };
}

export function scriptCaptions(rows: ScriptSegment[]) {
  function time(ms: number) {
    const value = Math.max(0, Math.floor(ms));
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(Math.floor(value / 3_600_000))}:${two(Math.floor(value / 60_000) % 60)}:${two(Math.floor(value / 1000) % 60)}.${String(value % 1000).padStart(3, "0")}`;
  }
  const cues = rows.map((row, index) => {
    const text = row.text.replace(/[\r\n]+/g, " ").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `${index + 1}\n${time(row.startMs)} --> ${time(Math.max(row.startMs + 1, row.endMs))}\n${text}\n`;
  });
  return `data:text/vtt;charset=utf-8,${encodeURIComponent("WEBVTT\n\n" + cues.join("\n"))}`;
}

export function manuscriptParagraphs(segments: ScriptSegment[]) {
  const paragraphs: string[] = [];
  let current = "", previousEnd = 0;
  for (const row of segments) {
    const text = row.text.trim();
    if (!text) continue;
    const gap = row.startMs - previousEnd;
    if (current && (current.length + text.length > 180 || gap >= 800 || (current.length >= 80 && (gap >= 200 || /[。！？!?]$/u.test(current))))) {
      paragraphs.push(current);
      current = "";
    }
    // Keep adjacent unpunctuated speech fragments readable without adding inferred words or punctuation.
    const separator = current && !/[，。！？；、,.;!?]$/u.test(current) && !/^[，。！？；、,.;!?]/u.test(text) ? " " : "";
    current += separator + text;
    previousEnd = row.endMs;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}
