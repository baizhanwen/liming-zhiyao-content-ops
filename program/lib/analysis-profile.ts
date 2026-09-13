export const analysisProfiles = ["standard", "max"] as const;
export const historicalAnalysisProfiles = ["economy", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];

export const analysisProfileBudgets: Record<AnalysisProfile, {
  sourceTokens: number;
  outputTokens: number;
  promptTokens: number;
}> = {
  standard: { sourceTokens: 32_000, outputTokens: 6_000, promptTokens: 1_600 },
  max: { sourceTokens: 64_000, outputTokens: 12_000, promptTokens: 1_600 },
};

export const analysisProfileSegmentLimits: Record<AnalysisProfile, number> = {
  standard: 6,
  max: 12,
};

export function estimateRepresentativeFrames(durationSeconds: number, profile: AnalysisProfile) {
  const duration = Math.max(0, durationSeconds);
  const interpolate = (minimum: number, maximum: number, ratio: number) => Math.round(minimum + (maximum - minimum) * Math.max(0, Math.min(1, ratio)));
  if (duration <= 600) return profile === "max" ? interpolate(24, 48, duration / 600) : interpolate(12, 24, duration / 600);
  if (duration <= 1_800) return profile === "max" ? interpolate(60, 120, (duration - 600) / 1_200) : interpolate(24, 60, (duration - 600) / 1_200);
  return profile === "max" ? interpolate(120, 180, (duration - 1_800) / 1_800) : interpolate(60, 90, (duration - 1_800) / 1_800);
}

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
  return value === "max" ? "max" : "standard";
}
