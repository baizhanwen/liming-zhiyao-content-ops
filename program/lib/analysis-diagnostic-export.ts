import { safeProgressObservation } from "./analysis-task-progress";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const milliseconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const secretKeys = new Set(["apikey", "authorization", "cookie", "setcookie", "password", "secret", "token", "accesstoken", "refreshtoken", "idtoken", "servicetoken", "analyzerservicetoken", "modelsettingsencryptionkey", "requestheaders", "responseheaders", "headers", "checkpoint", "checkpointjson", "leaseowner", "resultkey", "idempotencykey"]);

function diagnosticText(value: string) {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)[^\s/@"']+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z]:\\Users\\[^\\/\r\n"'<>]+/g, "[用户目录]")
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, "[用户目录]");
}

/** Keep report text intact; remove credential fields and sanitize diagnostic errors. */
export function sanitizeAnalysisDiagnostics(value: unknown, diagnostic = false): unknown {
  if (typeof value === "string") return diagnostic ? diagnosticText(value) : value;
  if (Array.isArray(value)) return value.map(item => sanitizeAnalysisDiagnostics(item, diagnostic));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return [key, secretKeys.has(normalized) || /(?:apikey|password|secret|secretkey|token)$/.test(normalized)
      ? "[REDACTED]" : sanitizeAnalysisDiagnostics(item, diagnostic || /error|diagnostic|message|reason|detail|exception/i.test(key))];
  }));
}

function pick(row: Row, fields: string[]) {
  return Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

export function diagnosticJobSnapshot(value: Row | null) {
  if (!value) return null;
  let observation = null;
  try { observation = safeProgressObservation(JSON.parse(typeof value.progress_json === "string" ? value.progress_json : "null")); } catch { /* Missing historical observation. */ }
  return sanitizeAnalysisDiagnostics({ ...pick(value, ["id", "status", "analysis_profile", "visual_analysis_mode", "visual_sampling_level", "progress", "current_stage", "error_code", "error_message", "retry_count", "attempt_count", "resume_count", "started_at", "stage_started_at", "last_progress_at", "last_heartbeat_at", "created_at", "updated_at", "completed_at", "checkpoint_stage", "checkpoint_updated_at"]), observation });
}

export function analysisDiagnosticFilename(title: unknown, id: unknown) {
  const name = Array.from((typeof title === "string" ? title : "视频分析").toWellFormed().replace(/[\\/:*?"<>|\p{Cc}]/gu, "-")).slice(0, 80).join("").replace(/[. ]+$/g, "").trim() || "视频分析";
  const suffix = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) : "snapshot";
  return `${name}-分析诊断-${suffix || "snapshot"}.json`;
}

export function buildAnalysisDiagnosticExport(input: {
  exportedAt: string; organizationId: string; projectId: string; sourceProjectId: string;
  video: Row; analysis: Row | null; job: Row | null; latestJob: Row | null;
  events: Row[]; eventCount: number; eventsThrough: string;
}) {
  const { analysis, job } = input;
  const report = analysis?.report ?? null;
  const meta = record(record(report).analysis_meta), visual = record(meta.visual_extraction);
  const stage = record(visual.stage_timing), branch = record(visual.branch_timing);
  const unified = record(record(report).unified_report), reportTiming = record(unified.timing);
  const reused = typeof meta.evidence_reused === "boolean" ? meta.evidence_reused : typeof visual.evidence_reused === "boolean" ? visual.evidence_reused : null;
  const evidenceScope = reused === true ? "reused_evidence" : analysis ? "report_evidence" : "unknown";
  const timing = (key: string, label: string, value: unknown, source: string, scope = evidenceScope, basis = "wall") => ({ key, label, elapsedMs: milliseconds(value), source, scope, basis });
  const timings = [
    timing("source_download", "原片采集", null, "not_recorded", "unknown"),
    timing("media_preparation", "媒体与音轨准备", null, "not_recorded", "unknown"),
    timing("transcript_preparation", "口播准备（含字幕与保存，不等同于纯转写）", branch.transcription_elapsed_ms, "analysis_meta.visual_extraction.branch_timing.transcription_elapsed_ms"),
    timing("frame_extraction", "场景检测与抽帧", stage.frame_extraction_elapsed_ms, "analysis_meta.visual_extraction.stage_timing.frame_extraction_elapsed_ms"),
    timing("frame_filter", "候选画面筛选", stage.frame_filter_elapsed_ms, "analysis_meta.visual_extraction.stage_timing.frame_filter_elapsed_ms"),
    timing("ocr", "画面文字识别", stage.ocr_elapsed_ms, "analysis_meta.visual_extraction.stage_timing.ocr_elapsed_ms"),
    timing("vision", "画面理解", stage.vision_elapsed_ms, "analysis_meta.visual_extraction.stage_timing.vision_elapsed_ms"),
    timing("ocr_vision_wall", "文字识别与画面理解合计墙钟耗时", stage.ocr_vision_wall_ms, "analysis_meta.visual_extraction.stage_timing.ocr_vision_wall_ms"),
    timing("ocr_vision_overlap", "文字识别与画面理解重叠时间", stage.ocr_vision_overlap_ms, "analysis_meta.visual_extraction.stage_timing.ocr_vision_overlap_ms", evidenceScope, "overlap"),
    timing("visual_pipeline", "画面处理总耗时", branch.visual_elapsed_ms, "analysis_meta.visual_extraction.branch_timing.visual_elapsed_ms"),
    timing("report_generation", "报告生成", reportTiming.elapsed_ms, "unified_report.timing.elapsed_ms", "report_execution"),
    timing("transcript_review", "口播校对", reportTiming.canonical_elapsed_ms, "unified_report.timing.canonical_elapsed_ms", "report_execution"),
    timing("content_modules", "内容模块生成", reportTiming.modules_elapsed_ms, "unified_report.timing.modules_elapsed_ms", "report_execution"),
    timing("artifact_persistence", "附件保存", null, "not_recorded", "unknown"),
  ];
  const sections = Array.isArray(unified.sections) ? unified.sections : [];
  const modules = sections.map(item => {
    const section = record(item), diagnostics = record(section.diagnostics);
    const performed = diagnostics.reused !== true && typeof diagnostics.attempts === "number" && diagnostics.attempts > 0;
    return { key: section.key ?? null, status: section.status ?? null, reused: diagnostics.reused ?? null,
      elapsedMs: performed ? milliseconds(diagnostics.elapsed_ms) : null, basis: "request_sum", diagnostics };
  });
  return {
    schemaVersion: "analysis-report-export.v1", exportedAt: input.exportedAt,
    selection: { organizationId: input.organizationId, projectId: input.projectId, sourceProjectId: input.sourceProjectId,
      videoId: input.video.id, analysisId: analysis?.id ?? null, jobId: analysis ? analysis.analysis_job_id ?? null : job?.id ?? null,
      reportCreatedAt: analysis?.created_at ?? null, reportSchemaVersion: analysis?.schema_version ?? null },
    video: sanitizeAnalysisDiagnostics(pick(input.video, ["id", "title", "filename", "platform", "source_type", "duration_sec", "status", "content_type", "size_bytes", "created_at"])),
    analysis: analysis ? sanitizeAnalysisDiagnostics(pick(analysis, ["id", "analysis_job_id", "schema_version", "confidence", "model_provider", "model_name", "prompt_version", "created_at"])) : null,
    report: sanitizeAnalysisDiagnostics(report),
    diagnostics: {
      visualAnalysisMode: analysis ? meta.visual_analysis_mode ?? visual.visual_analysis_mode ?? "hybrid" : job?.visual_analysis_mode ?? (job ? "hybrid" : null),
      visualSamplingLevel: analysis ? "visual_sampling_level" in meta ? meta.visual_sampling_level : visual.visual_sampling_level ?? null : job?.visual_sampling_level ?? null,
      timingUnit: "milliseconds", evidenceReused: reused, timings,
      notes: ["null 表示未记录或不适用；不会按视频时长估算耗时。", "OCR 与画面理解可能并行，不能把二者耗时直接相加。", "report_evidence 是该报告携带的证据计时，不保证全部由当前执行轮次产生；reused_evidence 明确表示复用。", "任务快照记录导出时状态；同一任务后续重试可能改变它，不代表历史报告生成时状态。", "只包含此视频可访问的报告和任务诊断；不包含主机环境配置或 GPU 环境检测文件。"],
      visual: sanitizeAnalysisDiagnostics(visual, true),
      modules: sanitizeAnalysisDiagnostics(modules, true),
      modelRequests: sanitizeAnalysisDiagnostics(meta.model_requests ?? [], true),
      jobSnapshotObservedAt: input.exportedAt, jobSnapshot: diagnosticJobSnapshot(job),
      latestJobSnapshot: input.latestJob?.id !== job?.id ? diagnosticJobSnapshot(input.latestJob) : null,
      events: { jobId: job?.id ?? null, through: input.eventsThrough, scope: analysis ? "report_job_through_report_creation" : "job_lifecycle_as_of_export",
        available: Boolean(job), totalCount: input.eventCount, exportedCount: input.events.length, truncated: input.eventCount > input.events.length,
        items: sanitizeAnalysisDiagnostics(input.events, true) },
    },
  };
}
