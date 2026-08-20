export const analysisProfiles = ["max"] as const;
export const historicalAnalysisProfiles = ["economy", "standard", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];
export type HistoricalAnalysisProfile = typeof historicalAnalysisProfiles[number];
export type AnalysisProfileValue = AnalysisProfile | HistoricalAnalysisProfile | "shared";

export const analysisProfileBudgets: Record<AnalysisProfile, {
  sourceTokens: number;
  outputTokens: number;
  promptTokens: number;
}> = {
  max: { sourceTokens: 64_000, outputTokens: 12_000, promptTokens: 1_600 },
};

export const analysisProfileSegmentLimits: Record<AnalysisProfile, number> = {
  max: 12,
};

export function estimateMediaSourceTokens(durationSeconds: number, profile: AnalysisProfile) {
  const estimated = Math.max(1_200, Math.round(durationSeconds / 60 * 320 + 600));
  return Math.min(estimated, analysisProfileBudgets[profile].sourceTokens);
}

export function estimateAnalysisMaximumTokens(durationSeconds: number, profile: AnalysisProfile) {
  const budget = analysisProfileBudgets[profile];
  if (durationSeconds < 1_800) return budget.sourceTokens + budget.promptTokens + budget.outputTokens;
  const segments = Math.min(analysisProfileSegmentLimits[profile], Math.max(2, Math.ceil(durationSeconds / 600)));
  const partialOutputPerSegment = Math.min(500, Math.max(300, Math.floor((budget.outputTokens - 1_200) / segments)));
  return budget.sourceTokens + budget.promptTokens * (segments + 1) + partialOutputPerSegment * segments + budget.outputTokens;
}

export function normalizeAnalysisProfile(value: unknown): AnalysisProfile {
  // Historical profile values remain readable in old jobs and reports, but can
  // never select the capability of a newly-created task.
  void value;
  return "max";
}
