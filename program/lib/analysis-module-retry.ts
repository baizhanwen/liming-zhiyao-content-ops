import { readContentAnalysis, type ContentAnalysis } from "./video-content-analysis.ts";
import { readVideoUnifiedReport, unifiedModuleKeys, type UnifiedModuleKey } from "./unified-report.ts";

export type AnalysisModuleRetryKey = UnifiedModuleKey | "canonical";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textModuleKeys = ["text_topic_structure_audience", "text_expression_value"] as const;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/u.test(value);

/** Recover independent OCR only when the original speech and images still match the saved report. */
function hasMatchingReviewOcr(checkpoint: Record<string, unknown>, content: ContentAnalysis, canonical: {
  status: string; segments: Array<{ source_segment_id: string; start_ms: number; end_ms: number; original_text: string; text: string; review_status: string }>;
}) {
  if (canonical.status !== "needs_review" || !canonical.segments.length || canonical.segments.some(row => row.review_status !== "needs_review")) return false;
  const { media, transcript, visuals, unified_progress: progress } = checkpoint;
  if (!record(media) || !record(transcript) || !record(visuals) || !record(progress)
      || !Number.isSafeInteger(media.duration_ms) || Number(media.duration_ms) <= 0
      || media.duration_ms !== content.metrics.media.duration_ms || !media.video_codec
      || typeof transcript.language !== "string" || !transcript.language
      || !Array.isArray(transcript.segments) || transcript.segments.length !== canonical.segments.length
      || !Array.isArray(visuals.keyframes) || !visuals.keyframes.length || !Array.isArray(visuals.observations)
      || !record(visuals.stats) || !record(progress.canonical)) return false;
  const saved = progress.canonical;
  if (saved.version !== "canonical-transcript.v2" || saved.status !== "needs_review" || !hash(saved.source_hash)
      || !Array.isArray(saved.segments) || saved.segments.length !== canonical.segments.length) return false;
  const sourceSegments = transcript.segments, cachedSegments = saved.segments;
  if (!canonical.segments.every((segment, index) => {
    const source = sourceSegments[index], cached = cachedSegments[index];
    return record(source) && record(cached) && segment.source_segment_id === `transcript:${String(index + 1).padStart(4, "0")}`
      && source.start_ms === segment.start_ms && source.end_ms === segment.end_ms && source.text === segment.original_text
      && cached.source_segment_id === segment.source_segment_id && cached.start_ms === segment.start_ms
      && cached.end_ms === segment.end_ms && cached.original_text === segment.original_text
      && cached.text === segment.text && cached.review_status === "needs_review";
  })) return false;
  const registry = new Map(content.evidence_registry.map(row => [row.id, row]));
  if (content.evidence_registry.some(row => row.source === "transcript")
      || content.evidence_registry.filter(row => row.source === "frame").length !== visuals.keyframes.length) return false;
  let ocrCount = 0;
  if (!visuals.keyframes.every((frame, index) => {
    if (!record(frame) || !Number.isSafeInteger(frame.timestamp_ms) || Number(frame.timestamp_ms) < 0
        || Number(frame.timestamp_ms) > Number(media.duration_ms)) return false;
    const suffix = String(index + 1).padStart(4, "0"), observed = registry.get(`frame:${suffix}`);
    if (!observed || observed.start_ms !== frame.timestamp_ms || observed.end_ms !== frame.timestamp_ms
        || observed.asset_ref !== (frame.asset_id ?? null)) return false;
    const ocr = registry.get(`ocr:${suffix}`), hasText = typeof frame.ocr_text === "string" && Boolean(frame.ocr_text.trim());
    if (!hasText) return !ocr;
    ocrCount += 1;
    return Boolean(ocr && ocr.source === "ocr" && ocr.start_ms === frame.timestamp_ms && ocr.end_ms === frame.timestamp_ms
      && ocr.text === frame.ocr_text && ocr.asset_ref === observed.asset_ref);
  })) return false;
  if (!ocrCount || content.evidence_registry.filter(row => row.source === "ocr").length !== ocrCount) return false;
  let visionCount = 0;
  if (!visuals.observations.every((observation, index) => {
    if (!record(observation) || observation.kind !== "vision") return true;
    visionCount += 1;
    const row = registry.get(`vision:${String(index + 1).padStart(4, "0")}`);
    return Boolean(row && row.source === "vision" && row.start_ms === observation.start_ms
      && row.end_ms === observation.end_ms && row.text === observation.text);
  })) return false;
  return visionCount === content.evidence_registry.filter(row => row.source === "vision").length;
}
export function readEvidenceCheckpoint(raw: string | null | undefined) {
  if (!raw || raw.length > 1_000_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) && value.checkpoint_version === 1 && record(value.media) && record(value.transcript) && record(value.visuals) ? value : null;
  } catch { return null; }
}

/** The saved report determines failure; a missing cache entry only means pending. */
export function readAnalysisModuleRetryState(checkpointJson: string | null | undefined, schema: unknown, report: unknown, jobStatus?: string) {
  const checkpoint = readEvidenceCheckpoint(checkpointJson);
  if (!["analysis.v11", "analysis.v12"].includes(String(schema)) || !record(report)) return null;
  const content = readContentAnalysis(report);
  const unified = readVideoUnifiedReport(report.unified_report, content);
  if (unified.status !== "valid") return null;
  if (unified.value.version !== (schema === "analysis.v12" ? "unified-report.v2" : "unified-report.v1")) return null;
  const reviewed = unified.value.version === "unified-report.v2" ? unified.value : null;
  const reviewSegmentIds = reviewed?.canonical.segments.filter(segment => segment.review_status === "needs_review").map(segment => segment.source_segment_id) ?? [];
  const canonicalNeedsReview = reviewed?.canonical.status === "needs_review" && reviewSegmentIds.length > 0;
  const reportedFailedModuleKeys: AnalysisModuleRetryKey[] = unified.value.canonical.status === "failed" && !reviewed ? ["canonical"]
    : [...(unified.value.canonical.status === "failed" || canonicalNeedsReview ? ["canonical" as const] : []), ...unified.value.sections.filter(section => section.status === "failed").map(section => section.key)];
  const incompleteUpstream = unified.value.sections.filter(section => section.key !== "synthesis" && !["completed", "not_applicable"].includes(section.status)).map(section => section.key);
  const blockedModuleKeys: AnalysisModuleRetryKey[] = !reviewed && incompleteUpstream.length ? ["synthesis"] : [];
  const progress = checkpoint && record(checkpoint.unified_progress) ? checkpoint.unified_progress : null;
  const matchingCheckpoint = Boolean(checkpoint && progress?.version === (reviewed ? "unified-progress.v2" : "unified-progress.v1")
    && progress.protocol_version === (reviewed ? "unified-analysis.v2" : "unified-analysis.v1") && progress.source_signature === unified.value.source_signature);
  const cachedModules = record(progress?.modules) ? progress.modules : null;
  const independentOcrRecovery = Boolean(matchingCheckpoint && checkpoint && reviewed && content && canonicalNeedsReview
    && ["partial", "failed"].includes(jobStatus ?? "") && hasMatchingReviewOcr(checkpoint, content, reviewed.canonical)
    && ["visual", "synthesis"].every(key => {
      const section = unified.value.sections.find(section => section.key === key), cached = cachedModules?.[key];
      if (key === "visual" && section?.status === "not_acquired" && section.reason === "required_evidence_not_acquired"
          && content!.module_status.visual.status === "not_acquired" && !cached
          && !content!.evidence_registry.some(row => row.source === "vision")) return true;
      return section?.status === "completed" && record(cached) && cached.status === "completed" && hash(cached.signature)
        && record(cached.validation) && cached.validation.passed === true && record(cached.response) && Array.isArray(cached.findings);
    }));
  const recoverableTextModuleKeys = independentOcrRecovery ? textModuleKeys.filter(key => {
    const section = unified.value.sections.find(section => section.key === key), module = content!.module_status[key];
    return section?.status === "not_acquired" && section.reason === "required_evidence_not_acquired"
      && module.status === "not_acquired" && ["required_evidence_not_acquired", "trusted_transcript_not_acquired"].includes(module.reason ?? "");
  }) : [];
  const failedModuleKeys: AnalysisModuleRetryKey[] = [...new Set([...reportedFailedModuleKeys, ...recoverableTextModuleKeys])];
  const defaultModuleKeys = recoverableTextModuleKeys.length ? failedModuleKeys.filter(key => key !== "canonical")
    : failedModuleKeys.includes("canonical") ? ["canonical" as const] : failedModuleKeys;
  const completeCache = cachedModules && unifiedModuleKeys.every(key => {
    const module = cachedModules[key];
    return record(module) && module.status === "completed" && typeof module.signature === "string" && /^[a-f\d]{64}$/u.test(module.signature)
      && record(module.validation) && module.validation.passed === true && record(module.response) && Array.isArray(module.findings);
  });
  const reportRevalidationAvailable = Boolean(["partial", "failed"].includes(jobStatus ?? "") && matchingCheckpoint && completeCache && record(progress?.canonical)
    && ["completed", "needs_review", "not_applicable"].includes(String(progress.canonical.status))
    && unified.value.sections.every(section => section.status === "completed"));
  const available = matchingCheckpoint && Boolean(failedModuleKeys.length || reportRevalidationAvailable);
  return { available, reportRevalidationAvailable, failedModuleKeys, defaultModuleKeys, recoverableTextModuleKeys, blockedModuleKeys, incompleteUpstream, checkpoint, sourceSignature: unified.value.source_signature, reviewSegmentIds, canonicalNeedsReview, schema };
}

export function parseReviewSegmentIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 1_000 || value.some(id => typeof id !== "string" || id.length > 40 || !/^transcript:\d{4,}$/u.test(id))) return null;
  return [...new Set(value)] as string[];
}

export function parseAnalysisModuleRetryKeys(value: unknown): AnalysisModuleRetryKey[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(key => typeof key !== "string" || key !== "canonical" && !(unifiedModuleKeys as readonly string[]).includes(key))) return null;
  return [...new Set(value)] as AnalysisModuleRetryKey[];
}
