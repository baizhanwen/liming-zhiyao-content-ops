import { readVideoUnifiedReport } from "./unified-report.ts";
import { readVideoContentAnalysis, getDimensionLabel } from "./video-content-analysis.ts";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const qualityGatedAnalysisSchemas = ["analysis.v7", "analysis.v8", "analysis.v9", "analysis.v10", "analysis.v11", "analysis.v12"] as const;
export const isQualityGatedAnalysisSchema = (value: unknown) => typeof value === "string" && (qualityGatedAnalysisSchemas as readonly string[]).includes(value);
export const isLegacyAnalysisSchema = (value: unknown) => typeof value === "string" && /^analysis\.v[1-6]$/u.test(value);
export const isKnownAnalysisSchema = (value: unknown) => isQualityGatedAnalysisSchema(value) || isLegacyAnalysisSchema(value);
export const hasPassedQualityAudit = (audit: Record<string, unknown> | null) => audit?.status === "passed" && audit.acceptance_passed === true && audit.completion_status === "complete";

export type AnalysisQuality = { accepted: boolean; known: boolean; legacy: boolean; issues: string[]; reviewSegmentCount?: number; manuscriptStatus?: "verified" | "needs_review" | "unavailable" | "not_applicable" };

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
  const unifiedContract = schemaVersion === "analysis.v11" || schemaVersion === "analysis.v12";
  let reviewSegmentCount = 0;
  let manuscriptStatus: AnalysisQuality["manuscriptStatus"];
  if (!unifiedContract && !hasPassedQualityAudit(audit)) issues.unshift("质量审计缺失或未通过。");
  if (typeof meta?.contract_version === "string" && meta.contract_version !== schemaVersion) { validContract = false; issues.push("报告声明的契约版本与记录不一致。"); }
  if (schemaVersion === "analysis.v10" || unifiedContract) {
    if (meta?.contract_version !== schemaVersion) { validContract = false; issues.push("新版报告缺少一致的契约版本声明。"); }
    const content = readVideoContentAnalysis(body.content_analysis);
    if (content.status !== "valid") { validContract = false; issues.push(...content.issues); }
    else if (content.value.status !== "complete" || !content.value.validation.passed) { validContract = false; issues.push("结构化内容分析尚未完整通过验收。"); }
  }
  if (unifiedContract) {
    const content = readVideoContentAnalysis(body.content_analysis);
    const unified = readVideoUnifiedReport(body.unified_report, content.status === "valid" ? content.value : null);
    if (unified.status !== "valid") { validContract = false; issues.push(...unified.issues); }
    else {
      if (unified.value.version !== (schemaVersion === "analysis.v12" ? "unified-report.v2" : "unified-report.v1")) { validContract = false; issues.push("分析版本与统一报告版本不一致。"); }
      if (unified.value.status !== "complete" || !unified.value.validation.passed) { validContract = false; issues.push("统一报告尚未完整通过验收。"); }
      if (unified.value.version === "unified-report.v2") {
        reviewSegmentCount = unified.value.outcome.review_segment_count;
        manuscriptStatus = unified.value.outcome.manuscript;
        const safeScript = unified.value.canonical.segments.filter(segment => segment.review_status === "accepted").map(segment => segment.text).join("").replace(/\s/gu, "");
        const compatibilityScript = Array.isArray(body.spoken_script) && body.spoken_script.every(item => typeof item === "string") ? body.spoken_script.join("").replace(/\s/gu, "") : null;
        if (compatibilityScript !== safeScript) { validContract = false; issues.push("兼容口播字段必须只包含已核对片段，不能把待核对原文或候选稿作为事实。"); }
        const scriptSet = record(body.spoken_script_set), corrected = record(scriptSet?.corrected_original);
        if (corrected && (typeof corrected.text !== "string" || corrected.text.replace(/\s/gu, "") !== safeScript
          || !Array.isArray(corrected.paragraphs) || corrected.paragraphs.some(item => typeof item !== "string") || corrected.paragraphs.join("").replace(/\s/gu, "") !== safeScript
          || unified.value.outcome.manuscript !== "verified" && corrected.status === "completed")) { validContract = false; issues.push("旧版完整口播入口不能把待核对稿标为已完成。"); }
      }
    }
    if (content.status === "valid" && content.value.methodology.transcript_basis !== "canonical") { validContract = false; issues.push("新版报告必须以同一份校正文本为分析依据。"); }
  }
  return { accepted: (unifiedContract || hasPassedQualityAudit(audit)) && validContract, known, legacy, issues: [...new Set(issues)], ...(schemaVersion === "analysis.v12" ? { reviewSegmentCount, manuscriptStatus } : {}) };
}

/** A completion notice names the actual module failure and manuscript coverage in plain language. */
export function analysisCompletionMessage(schemaVersion: unknown, report: unknown, quality = assessAnalysisQuality(schemaVersion, report)) {
  const body = record(report), content = readVideoContentAnalysis(body?.content_analysis);
  const unified = readVideoUnifiedReport(body?.unified_report, content.status === "valid" ? content.value : null);
  const review = quality.reviewSegmentCount ? `${quality.reviewSegmentCount}句口播待核对` : "";
  if (quality.accepted) return review ? `分析完成，${review}。` : "分析完成。";
  const names = { text_topic_structure_audience: "选题、结构与人群", text_expression_value: "文案、价值与行动", visual: "画面与镜头", synthesis: "综合判断与建议" };
  const reasons: Record<string, string> = { length: "输出被截断", overloaded: "模型服务繁忙", timeout: "响应超时", provider_error: "调用未完成", schema_invalid: "返回格式不符合约定", evidence_invalid: "结论依据不足", input_budget: "材料超出处理范围", canonical_failed: "口播校正未通过核对", not_requested: "本次未重试", upstream_module_failed: "上游内容未完成" };
  const validationCause = (issues: string[]) => issues.flatMap(issue => {
    const [code, dimensionId] = issue.split(":");
    const dimension = dimensionId && getDimensionLabel(dimensionId) !== dimensionId ? `“${getDimensionLabel(dimensionId)}”` : "该项分类";
    const descriptions: Record<string, string> = {
      insufficient_evidence_modality: `${dimension}缺少对应的文字或画面依据`,
      first_frame_evidence_required: `${dimension}没有引用首帧的视觉观察`,
      opening_evidence_required: `${dimension}没有引用前三秒的画面`,
      ordered_frame_group_required: `${dimension}缺少有序连续帧依据`,
      invalid_tag_selection: `${dimension}返回了互斥或数量不符的标签`,
      known_requires_evidence: `${dimension}缺少支持判断的来源`,
      compact_missing_dimension: "部分分类维度没有返回",
      compact_response_shape: "模型返回的结构与本模块约定不一致",
      segment_invalid: "部分内容片段的标签或来源范围不符合约定",
      segment_modality: "部分内容片段缺少对应的文字或画面依据",
      visual_finding_requires_vision: "画面结论没有引用真实视觉观察",
      finding_requires_semantic_source: "内容结论只引用了空帧或帧组",
    };
    return descriptions[code] ? [descriptions[code]] : [];
  });
  const failures = unified.status === "valid" ? unified.value.sections.filter(section => !["completed", "not_applicable"].includes(section.status)).map(section => {
    const specific = schemaVersion === "analysis.v12" && content.status === "valid" ? [...new Set(validationCause(content.value.module_status[section.key].validation.issues))].slice(0, 2).join("，") : "";
    return `${names[section.key]}：${specific || reasons[section.reason ?? ""] || reasons[section.diagnostics.failure_kind ?? ""] || "所需材料或有效结果尚未取得"}`;
  }) : [];
  const details = failures.length ? failures : quality.issues.filter(issue => /[\p{Script=Han}]/u.test(issue)).slice(0, 3);
  return `部分分析已生成${review ? `，${review}` : ""}${details.length ? `；${details.join("；")}` : "，仍有内容需要核对或重试"}。`;
}

/** Small listing projections have the task's authoritative validation result. */
export function projectedAnalysisNeedsReview(schemaVersion: unknown, audit: { status?: unknown; acceptance_passed?: unknown; completion_status?: unknown } | null) {
  if (isLegacyAnalysisSchema(schemaVersion)) return false;
  return !isQualityGatedAnalysisSchema(schemaVersion) || !hasPassedQualityAudit(audit as Record<string, unknown> | null);
}
