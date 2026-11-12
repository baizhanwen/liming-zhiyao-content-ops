import { activeAnalysisStatuses } from "./analysis-jobs";
import { assessAnalysisQuality, projectedAnalysisNeedsReview, analysisCompletionMessage } from "./analysis-quality";
export { hasPassedQualityAudit } from "./analysis-quality";

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function importedAnalysisState(analyses: Record<string, unknown>[], now: string) {
  if (!analyses.length) return { videoStatus: "pending", jobStatus: null, stage: "已迁入素材，尚未分析", errorCode: null, message: "迁移包未包含分析报告，请打开素材详情核对来源后主动重新分析。" };
  const latest = [...analyses].sort((a,b) => String(b.created_at || now) > String(a.created_at || now) ? 1 : String(b.created_at || now) < String(a.created_at || now) ? -1 : 0)[0];
  let body: Record<string, unknown> | null = null;
  try { body = record(typeof latest.report_json === "string" ? JSON.parse(latest.report_json) : latest.report_json); } catch { /* Manifest validation reports invalid JSON before writes. */ }
  const audit = record(record(body?.analysis_meta)?.quality_audit);
  const quality = assessAnalysisQuality(latest.schema_version, body);
  const partial = !quality.accepted;
  const manuscriptReview = quality.manuscriptStatus === "needs_review" && quality.reviewSegmentCount ? `${quality.reviewSegmentCount}句口播待核对` : null;
  const issues = Array.isArray(audit?.issues) ? audit.issues.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0,3).map(item => item.trim().slice(0,500)) : [];
  return { videoStatus: "ready", jobStatus: partial ? "partial" : "completed", stage: partial ? "已迁入部分报告" : manuscriptReview ? `已迁入分析报告，${manuscriptReview}` : "已迁入分析报告", errorCode: partial ? "ANALYSIS_PARTIAL" : null,
    message: latest.schema_version === "analysis.v12" && (partial || manuscriptReview) ? analysisCompletionMessage(latest.schema_version, body, quality) : partial ? issues.length ? `报告已迁入，但有质量项未通过：${issues.join("；")}` : "报告已迁入，但质量审计或契约校验未通过。" : null };
}

// Both library queries join latest_analysis and j. Return only small audit
// fields, not complete report JSON in a 300-entry listing.
export const materialAnalysisProjection = (jobAlias: "j" | "analysis_jobs" = "j") => `latest_analysis.id AS analysis_id, latest_analysis.schema_version AS analysis_schema_version,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.analysis_meta.quality_audit.status') END AS analysis_quality_status,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.analysis_meta.quality_audit.acceptance_passed') END AS analysis_acceptance_passed,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.analysis_meta.quality_audit.completion_status') END AS analysis_completion_status,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.unified_report.outcome.manuscript') END AS analysis_manuscript_status,
  CASE WHEN json_valid(latest_analysis.report_json) THEN json_extract(latest_analysis.report_json,'$.unified_report.outcome.review_segment_count') END AS analysis_review_segment_count,
  CASE WHEN ${jobAlias}.idempotency_key LIKE 'material-import:%' THEN 1 ELSE 0 END AS is_imported_job`;

export const materialAnalysisColumns = materialAnalysisProjection();

export function materialCardState(entry: { analysis_id?: string | null; analysis_schema_version?: string | null; analysis_quality_status?: string | null; analysis_acceptance_passed?: number | boolean | null; analysis_completion_status?: string | null; analysis_manuscript_status?: string | null; analysis_review_segment_count?: number | null; is_imported_job?: number; job_status: string | null; current_stage: string | null }) {
  const hasReport = Boolean(entry.analysis_id);
  if (entry.job_status && (activeAnalysisStatuses as readonly string[]).includes(entry.job_status)) return { label: entry.current_stage || "分析处理中", tone: "neutral", hint: hasReport ? "已有报告仍可查看，新分析尚未完成。" : "正在等待或处理分析任务。" };
  if (entry.job_status === "failed" || entry.job_status === "cancelled") return { label: hasReport ? entry.job_status === "failed" ? "已有报告 · 最近分析失败" : "已有报告 · 任务已取消" : entry.job_status === "failed" ? "分析失败" : "已取消", tone: entry.job_status === "failed" ? "danger" : "neutral", hint: "打开详情查看原因；已有报告会保留。" };
  if (!hasReport && entry.job_status === "partial") return { label: "报告待核对", tone: "warning", hint: "任务标为部分完成，但未找到报告，请先在详情中核对。" };
  if (!hasReport) return { label: "尚未分析", tone: "neutral", hint: "尚无分析报告，可打开详情核对来源后主动分析。" };
  if (entry.job_status === "partial" || projectedAnalysisNeedsReview(entry.analysis_schema_version, { status: entry.analysis_quality_status, acceptance_passed: entry.analysis_acceptance_passed === 1 || entry.analysis_acceptance_passed === true, completion_status: entry.analysis_completion_status })) return { label: "报告部分完成", tone: "warning", hint: "报告可查看，但质量检查未完整通过。" };
  if (entry.analysis_schema_version === "analysis.v12" && entry.analysis_manuscript_status === "needs_review") {
    const count = Number.isSafeInteger(entry.analysis_review_segment_count) && Number(entry.analysis_review_segment_count) > 0 ? `${entry.analysis_review_segment_count}句` : "";
    return { label: `${entry.is_imported_job ? "已迁入报告" : "分析完成"} · ${count}口播待核对`, tone: "warning", hint: "内容报告已完成；待核对口播保留原文，不作为已确认事实。" };
  }
  return { label: entry.is_imported_job ? "已迁入报告" : "分析完成", tone: "success", hint: "" };
}
