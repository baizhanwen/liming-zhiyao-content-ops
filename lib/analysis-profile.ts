export const analysisProfiles = ["economy", "standard", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];

export const analysisProfileBudgets: Record<AnalysisProfile, {
  sourceTokens: number;
  outputTokens: number;
  promptTokens: number;
}> = {
  economy: { sourceTokens: 8_000, outputTokens: 2_000, promptTokens: 1_200 },
  standard: { sourceTokens: 18_000, outputTokens: 4_000, promptTokens: 1_200 },
  deep: { sourceTokens: 32_000, outputTokens: 12_000, promptTokens: 1_200 },
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
  const finalPasses = profile === "deep" ? 2 : 1;
  if (durationSeconds < 1_800) return budget.sourceTokens * finalPasses + budget.promptTokens * finalPasses + budget.outputTokens;
  const segments = Math.min(analysisProfileSegmentLimits[profile], Math.max(2, Math.ceil(durationSeconds / 600)));
  const partialOutputPerSegment = profile === "deep"
    ? Math.min(600, Math.max(400, Math.floor((budget.outputTokens - 4_800) / segments)))
    : Math.min(350, Math.max(220, Math.floor((budget.outputTokens - 1_200) / segments)));
  const partialOutput = partialOutputPerSegment * segments;
  return budget.sourceTokens
    + budget.promptTokens * (segments + finalPasses)
    + partialOutput * finalPasses
    + budget.outputTokens;
}

export function normalizeAnalysisProfile(value: unknown): AnalysisProfile {
  return typeof value === "string" && (analysisProfiles as readonly string[]).includes(value) ? value as AnalysisProfile : "standard";
}
