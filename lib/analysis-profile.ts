export const analysisProfiles = ["economy", "standard", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];

export const analysisProfileBudgets: Record<AnalysisProfile, {
  sourceTokens: number;
  outputTokens: number;
  promptTokens: number;
}> = {
  economy: { sourceTokens: 8_000, outputTokens: 2_000, promptTokens: 1_200 },
  standard: { sourceTokens: 18_000, outputTokens: 4_000, promptTokens: 1_200 },
  deep: { sourceTokens: 32_000, outputTokens: 6_000, promptTokens: 1_200 },
};

export const analysisProfileSegmentLimits: Record<AnalysisProfile, number> = {
  economy: 2,
  standard: 4,
  deep: 6,
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
  return typeof value === "string" && (analysisProfiles as readonly string[]).includes(value) ? value as AnalysisProfile : "standard";
}
