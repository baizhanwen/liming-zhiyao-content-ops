import { readContentAnalysis } from "./video-content-analysis.ts";
import { readVideoUnifiedReport, unifiedModuleKeys, type UnifiedModuleKey } from "./unified-report.ts";

export type AnalysisModuleRetryKey = UnifiedModuleKey | "canonical";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function readEvidenceCheckpoint(raw: string | null | undefined) {
  if (!raw || raw.length > 1_000_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) && value.checkpoint_version === 1 && record(value.media) && record(value.transcript) && record(value.visuals) ? value : null;
  } catch { return null; }
}

/** The saved report determines failure; a missing cache entry only means pending. */
export function readAnalysisModuleRetryState(checkpointJson: string | null | undefined, schema: unknown, report: unknown) {
  const checkpoint = readEvidenceCheckpoint(checkpointJson);
  if (schema !== "analysis.v11" || !record(report)) return null;
  const unified = readVideoUnifiedReport(report.unified_report, readContentAnalysis(report));
  if (unified.status !== "valid") return null;
  const failedModuleKeys: AnalysisModuleRetryKey[] = unified.value.canonical.status === "failed" ? ["canonical"]
    : unified.value.sections.filter(section => section.status === "failed").map(section => section.key);
  const incompleteUpstream = unified.value.sections.filter(section => section.key !== "synthesis" && !["completed", "not_applicable"].includes(section.status)).map(section => section.key);
  const blockedModuleKeys: AnalysisModuleRetryKey[] = incompleteUpstream.length ? ["synthesis"] : [];
  const progress = checkpoint && record(checkpoint.unified_progress) ? checkpoint.unified_progress : null;
  const available = Boolean(checkpoint && progress?.version === "unified-progress.v1"
    && progress.protocol_version === "unified-analysis.v1" && progress.source_signature === unified.value.source_signature && failedModuleKeys.length);
  return { available, failedModuleKeys, blockedModuleKeys, incompleteUpstream, checkpoint, sourceSignature: unified.value.source_signature };
}

export function parseAnalysisModuleRetryKeys(value: unknown): AnalysisModuleRetryKey[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(key => typeof key !== "string" || key !== "canonical" && !(unifiedModuleKeys as readonly string[]).includes(key))) return null;
  return [...new Set(value)] as AnalysisModuleRetryKey[];
}
