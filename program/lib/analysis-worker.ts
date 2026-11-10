import { safeProgressObservation } from "./analysis-task-progress";
import { isLeasedAnalysisStatus } from "./analysis-jobs";
import { analysisJobStatuses, canTransitionAnalysisJob, type AnalysisJobStatus } from "./analysis-jobs";
import { isPlainRecord, normalizeLeaseSeconds, normalizeWorkerId } from "./service-auth";

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,191}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export type WorkerJobRow = {
  id: string; organization_id: string; project_id: string; video_id: string; status: AnalysisJobStatus; progress: number; current_stage: string | null;
  lease_owner: string | null; lease_expires_at: string | null; attempt_count: number; version: number; result_key: string | null;
  progress_json?: string | null; stage_started_at?: string | null; last_progress_at?: string | null;
  checkpoint_stage?: string | null; checkpoint_json?: string | null; checkpoint_updated_at?: string | null; resume_count?: number;
};

function readStatus(value: unknown): AnalysisJobStatus | null {
  return typeof value === "string" && (analysisJobStatuses as readonly string[]).includes(value) ? value as AnalysisJobStatus : null;
}

function readProgress(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function readStage(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 160 ? value.trim() : null;
}

export type AnalyzerBrowserAuthStatus = "unknown" | "logged_in" | "not_logged_in" | "unavailable" | "disabled";

export function parseAnalyzerBrowserAuth(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const status = typeof value.status === "string" && ["unknown", "logged_in", "not_logged_in", "unavailable", "disabled"].includes(value.status)
    ? value.status as AnalyzerBrowserAuthStatus
    : null;
  const browser = typeof value.browser === "string" ? value.browser.trim().slice(0, 60) : "";
  const checkedAt = typeof value.checkedAt === "string" && !Number.isNaN(Date.parse(value.checkedAt)) ? value.checkedAt : null;
  const message = typeof value.message === "string" ? value.message.trim().slice(0, 300) : "";
  if (!status || !checkedAt) return null;
  return { status, browser: browser || null, checkedAt, message: message || null };
}
export function parseHeartbeatPayload(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const workerId = normalizeWorkerId(value.workerId); const status = readStatus(value.status); const progress = readProgress(value.progress); const stage = readStage(value.stage);
  const version = typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0 ? value.version : null;
  if (!workerId || !status || !isLeasedAnalysisStatus(status) || progress === null || !stage || version === null) return null;
  return { workerId, status, progress, stage, version, leaseSeconds: normalizeLeaseSeconds(value.leaseSeconds), observation: safeProgressObservation(value.observation), browserAuth: parseAnalyzerBrowserAuth(value.browserAuth) };
}

export function parseCheckpointPayload(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const workerId = normalizeWorkerId(value.workerId);
  const version = typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0 ? value.version : null;
  const stage = value.stage === "evidence_ready" || value.stage === "segment_progress" ? value.stage : null;
  const checkpoint = isPlainRecord(value.checkpoint) ? value.checkpoint : null;
  if (!workerId || version === null || !stage || !checkpoint) return null;
  const checkpointJson = JSON.stringify(checkpoint);
  if (checkpointJson.length <= 2 || checkpointJson.length > 1_000_000) return null;
  return { workerId, version, stage, checkpointJson };
}

export function parseCompletionPayload(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const workerId = normalizeWorkerId(value.workerId); const resultKey = typeof value.resultKey === "string" && SAFE_KEY.test(value.resultKey) ? value.resultKey : null;
  const version = typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0 ? value.version : null;
  const analysis = isPlainRecord(value.analysis) ? value.analysis : null;
  const schemaVersion = analysis && typeof analysis.schemaVersion === "string" && SAFE_KEY.test(analysis.schemaVersion) ? analysis.schemaVersion : null;
  const report = analysis && isPlainRecord(analysis.report) ? analysis.report : null;
  const confidence = analysis && (analysis.confidence === null || (typeof analysis.confidence === "number" && Number.isInteger(analysis.confidence) && analysis.confidence >= 0 && analysis.confidence <= 100)) ? analysis.confidence as number | null : undefined;
  if (!workerId || !resultKey || version === null || !analysis || !schemaVersion || !report || confidence === undefined) return null;

  const reportJson = JSON.stringify(report);
  if (reportJson.length > 1_000_000) return null;
  let transcript: null | { language: string; fullText: string; segmentsJson: string; confidence: number | null } = null;
  if (value.transcript !== undefined && value.transcript !== null) {
    if (!isPlainRecord(value.transcript)) return null;
    const language = typeof value.transcript.language === "string" && value.transcript.language.length <= 32 ? value.transcript.language : null;
    const fullText = typeof value.transcript.fullText === "string" && value.transcript.fullText.length <= 1_000_000 ? value.transcript.fullText : null;
    const segments = Array.isArray(value.transcript.segments) ? value.transcript.segments : null;
    const transcriptConfidence = value.transcript.confidence === null || (typeof value.transcript.confidence === "number" && Number.isInteger(value.transcript.confidence) && value.transcript.confidence >= 0 && value.transcript.confidence <= 100) ? value.transcript.confidence as number | null : undefined;
    if (!language || fullText === null || !segments || transcriptConfidence === undefined) return null;
    const segmentsJson = JSON.stringify(segments); if (segmentsJson.length > 1_000_000) return null;
    transcript = { language, fullText, segmentsJson, confidence: transcriptConfidence };
  }
  let sourceMetadata: null | {
    platformWorkId: string | null; title: string | null; authorName: string | null;
    publishedAt: string | null; durationSec: number | null;
    metrics: { plays: number | null; likes: number | null; comments: number | null; favorites: number | null; shares: number | null };
  } = null;
  if (value.sourceMetadata !== undefined && value.sourceMetadata !== null) {
    if (!isPlainRecord(value.sourceMetadata)) return null;
    const source = value.sourceMetadata;
    const optionalString = (key: string, maximum: number) => {
      if (source[key] === null || source[key] === undefined) return null;
      if (typeof source[key] !== "string") return undefined;
      const text = source[key].trim();
      return text.length === 0 ? null : text.length <= maximum ? text : undefined;
    };
    const platformWorkId = optionalString("platformWorkId", 200); const title = optionalString("title", 500); const authorName = optionalString("authorName", 300); const publishedAt = optionalString("publishedAt", 64);
    const durationSec = source.durationSec === null || source.durationSec === undefined ? null : typeof source.durationSec === "number" && Number.isSafeInteger(source.durationSec) && source.durationSec >= 0 && source.durationSec <= 86400 ? source.durationSec : undefined;
    const metricsValue = source.metrics === null || source.metrics === undefined ? {} : isPlainRecord(source.metrics) ? source.metrics : null;
    if (platformWorkId === undefined || title === undefined || authorName === undefined || publishedAt === undefined || durationSec === undefined || !metricsValue) return null;
    if (publishedAt !== null && Number.isNaN(Date.parse(publishedAt))) return null;
    const metric = (key: string) => metricsValue[key] === null || metricsValue[key] === undefined ? null : typeof metricsValue[key] === "number" && Number.isSafeInteger(metricsValue[key]) && metricsValue[key] >= 0 ? metricsValue[key] as number : undefined;
    const metrics = { plays: metric("plays"), likes: metric("likes"), comments: metric("comments"), favorites: metric("favorites"), shares: metric("shares") };
    if (Object.values(metrics).some((item) => item === undefined)) return null;
    sourceMetadata = { platformWorkId, title, authorName, publishedAt, durationSec, metrics: metrics as Record<keyof typeof metrics, number | null> };
  }
  const optionalText = (key: "modelProvider" | "modelName" | "promptVersion") => typeof analysis[key] === "string" && analysis[key].length <= 160 ? analysis[key] as string : null;
  return { workerId, resultKey, version, transcript, sourceMetadata, analysis: { schemaVersion, reportJson, confidence, modelProvider: optionalText("modelProvider"), modelName: optionalText("modelName"), promptVersion: optionalText("promptVersion") } };
}

export function parseFailurePayload(value: unknown) {
  if (!isPlainRecord(value)) return null;
  const workerId = normalizeWorkerId(value.workerId); const resultKey = typeof value.resultKey === "string" && SAFE_KEY.test(value.resultKey) ? value.resultKey : null;
  const version = typeof value.version === "number" && Number.isInteger(value.version) && value.version >= 0 ? value.version : null;
  const errorCode = typeof value.errorCode === "string" && SAFE_CODE.test(value.errorCode) ? value.errorCode : null;
  const errorMessage = typeof value.errorMessage === "string" && value.errorMessage.trim().length > 0 && value.errorMessage.trim().length <= 1000 ? value.errorMessage.trim() : null;
  const progress = readProgress(value.progress); const stage = readStage(value.stage);
  if (!workerId || !resultKey || version === null || !errorCode || !errorMessage || progress === null || !stage) return null;
  return { workerId, resultKey, version, errorCode, errorMessage, progress, stage };
}

export function validateHeartbeatTransition(job: WorkerJobRow, payload: NonNullable<ReturnType<typeof parseHeartbeatPayload>>, now: string) {
  if (job.lease_owner !== payload.workerId) return "LEASE_NOT_OWNED";
  if (!job.lease_expires_at || job.lease_expires_at <= now) return "LEASE_EXPIRED";
  if (job.version !== payload.version) return "JOB_VERSION_CONFLICT";
  if (payload.progress < job.progress) return "PROGRESS_REGRESSION";
  if (payload.status !== job.status && !canTransitionAnalysisJob(job.status, payload.status)) return "INVALID_STATUS_TRANSITION";
  return null;
}

export function canWorkerFail(status: AnalysisJobStatus) {
  return status !== "pending" && status !== "completed" && status !== "partial" && status !== "failed" && status !== "cancelled";
}
