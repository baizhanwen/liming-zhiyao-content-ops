export type AnalysisCollectionMode = "anonymous" | "cookie";

export const ANALYSIS_COLLECTION_MODE_LABELS: Record<AnalysisCollectionMode, string> = {
  anonymous: "匿名采集",
  cookie: "Cookie 采集",
};

export function isAnalysisCollectionMode(value: unknown): value is AnalysisCollectionMode {
  return value === "anonymous" || value === "cookie";
}

export function normalizeAnalysisCollectionMode(value: unknown): AnalysisCollectionMode {
  return value === "cookie" ? "cookie" : "anonymous";
}
