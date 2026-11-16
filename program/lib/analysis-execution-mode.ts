export const analysisExecutionModes = ["serial", "controlled_parallel"] as const;
export type AnalysisExecutionMode = typeof analysisExecutionModes[number];

export function isAnalysisExecutionMode(value: unknown): value is AnalysisExecutionMode {
  return value === "serial" || value === "controlled_parallel";
}

/** Old jobs and reports ran serially unless they explicitly recorded otherwise. */
export function normalizeAnalysisExecutionMode(value: unknown): AnalysisExecutionMode {
  return isAnalysisExecutionMode(value) ? value : "serial";
}

/** New submissions use the user's chosen default; old persisted rows keep serial. */
export function normalizeNewAnalysisExecutionMode(value: unknown): AnalysisExecutionMode {
  return isAnalysisExecutionMode(value) ? value : "controlled_parallel";
}

export const analysisExecutionModeLabels: Record<AnalysisExecutionMode, string> = {
  serial: "串行",
  controlled_parallel: "受控并行",
};
