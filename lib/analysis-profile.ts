export const analysisProfiles = ["economy", "standard", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];

export function normalizeAnalysisProfile(value: unknown): AnalysisProfile {
  return typeof value === "string" && (analysisProfiles as readonly string[]).includes(value) ? value as AnalysisProfile : "standard";
}
