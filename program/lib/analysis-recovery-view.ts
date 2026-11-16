import type { AnalysisReportView } from "./analysis-report-view";
import type { UnifiedModuleKey } from "./unified-report";

export type ModuleRecoveryFeedback = {
  module: UnifiedModuleKey | "canonical";
  tone: "pending" | "success" | "error";
  message: string;
};

/** Display the validated report's current failures instead of a historical job audit error. */
export function reportRecoverySummary(view: AnalysisReportView | null) {
  if (!view || view.invalid || view.legacy) return null;
  const failed = view.sections.filter(section => section.status === "failed");
  const reviews = view.reviews.length;
  if (!failed.length && !reviews) return null;
  const completed = view.sections.filter(section => section.status === "completed").length;
  const reasons = failed.map(section => `${section.name}：${section.reason || "尚未完成"}`);
  if (reviews) reasons.push(`${reviews} 处口播待核对`);
  return `已保留 ${completed} 个完成部分；待补充：${reasons.join("；")}。`;
}
