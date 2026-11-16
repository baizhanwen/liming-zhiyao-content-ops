export const visualAnalysisModes = ["hybrid", "vision_only"] as const;
export type VisualAnalysisMode = typeof visualAnalysisModes[number];

export function isVisualAnalysisMode(value: unknown): value is VisualAnalysisMode {
  return value === "hybrid" || value === "vision_only";
}

/** Historical jobs and reports used OCR together with the visual model. */
export function normalizeVisualAnalysisMode(value: unknown): VisualAnalysisMode {
  return value === "vision_only" ? "vision_only" : "hybrid";
}

/** New analysis requests use pure vision unless the caller selects another mode. */
export function normalizeNewVisualAnalysisMode(value: unknown): VisualAnalysisMode {
  return isVisualAnalysisMode(value) ? value : "vision_only";
}

export const visualAnalysisModeLabels: Record<VisualAnalysisMode, string> = {
  hybrid: "OCR＋视觉",
  vision_only: "纯视觉",
};
