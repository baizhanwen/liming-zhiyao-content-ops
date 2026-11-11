import { readVideoUnifiedReport } from "./unified-report.ts";
import { readVideoContentAnalysis } from "./video-content-analysis.ts";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const qualityGatedAnalysisSchemas = ["analysis.v7", "analysis.v8", "analysis.v9", "analysis.v10", "analysis.v11"] as const;
export const isQualityGatedAnalysisSchema = (value: unknown) => typeof value === "string" && (qualityGatedAnalysisSchemas as readonly string[]).includes(value);
export const isLegacyAnalysisSchema = (value: unknown) => typeof value === "string" && /^analysis\.v[1-6]$/u.test(value);
export const isKnownAnalysisSchema = (value: unknown) => isQualityGatedAnalysisSchema(value) || isLegacyAnalysisSchema(value);
export const hasPassedQualityAudit = (audit: Record<string, unknown> | null) => audit?.status === "passed" && audit.acceptance_passed === true && audit.completion_status === "complete";

export type AnalysisQuality = { accepted: boolean; known: boolean; legacy: boolean; issues: string[] };

/** Read-only: historical report bodies and persisted task states are never rewritten. */
export function assessAnalysisQuality(schemaVersion: unknown, report: unknown): AnalysisQuality {
  const legacy = isLegacyAnalysisSchema(schemaVersion);
  const known = isKnownAnalysisSchema(schemaVersion);
  if (!known) return { accepted: false, known, legacy, issues: ["当前版本不能验收此分析契约；报告原文仍保留。"] };
  const body = record(report);
  if (!body) return { accepted: false, known, legacy, issues: ["分析报告不是有效对象。"] };
  if (legacy) return { accepted: true, known, legacy, issues: [] };
  const meta = record(body.analysis_meta);
  const audit = record(meta?.quality_audit);
  let validContract = true;
  const issues = Array.isArray(audit?.issues) ? audit.issues.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 20).map(item => item.trim().slice(0, 500)) : [];
  if (schemaVersion !== "analysis.v11" && !hasPassedQualityAudit(audit)) issues.unshift("质量审计缺失或未通过。");
  if (typeof meta?.contract_version === "string" && meta.contract_version !== schemaVersion) { validContract = false; issues.push("报告声明的契约版本与记录不一致。"); }
  if (schemaVersion === "analysis.v10" || schemaVersion === "analysis.v11") {
    if (meta?.contract_version !== schemaVersion) { validContract = false; issues.push("新版报告缺少一致的契约版本声明。"); }
    const content = readVideoContentAnalysis(body.content_analysis);
    if (content.status !== "valid") { validContract = false; issues.push(...content.issues); }
    else if (content.value.status !== "complete" || !content.value.validation.passed) { validContract = false; issues.push("结构化内容分析尚未完整通过验收。"); }
  }
  if (schemaVersion === "analysis.v11") {
    const content = readVideoContentAnalysis(body.content_analysis);
    const unified = readVideoUnifiedReport(body.unified_report, content.status === "valid" ? content.value : null);
    if (unified.status !== "valid") { validContract = false; issues.push(...unified.issues); }
    else if (unified.value.status !== "complete" || !unified.value.validation.passed) { validContract = false; issues.push("统一报告尚未完整通过验收。"); }
    if (content.status === "valid" && content.value.methodology.transcript_basis !== "canonical") { validContract = false; issues.push("新版报告必须以同一份校正文本为分析依据。"); }
  }
  return { accepted: (schemaVersion === "analysis.v11" || hasPassedQualityAudit(audit)) && validContract, known, legacy, issues: [...new Set(issues)] };
}

/** Small listing projections have the task's authoritative validation result. */
export function projectedAnalysisNeedsReview(schemaVersion: unknown, audit: { status?: unknown; acceptance_passed?: unknown; completion_status?: unknown } | null) {
  if (isLegacyAnalysisSchema(schemaVersion)) return false;
  return !isQualityGatedAnalysisSchema(schemaVersion) || !hasPassedQualityAudit(audit as Record<string, unknown> | null);
}
