export const visualSamplingLevels = ["quick", "balanced", "detailed"] as const;
export type VisualSamplingLevel = typeof visualSamplingLevels[number];

export function isVisualSamplingLevel(value: unknown): value is VisualSamplingLevel {
  return value === "quick" || value === "balanced" || value === "detailed";
}

/** Only new tasks receive the new balanced default. */
export function normalizeVisualSamplingLevel(value: unknown): VisualSamplingLevel {
  return isVisualSamplingLevel(value) ? value : "balanced";
}

/** Missing historical metadata stays historical rather than acquiring a new label. */
export function readVisualSamplingLevel(value: unknown): VisualSamplingLevel | null {
  return isVisualSamplingLevel(value) ? value : null;
}

export function matchesVisualSamplingLevel(value: unknown, expected: unknown) {
  return (value == null || isVisualSamplingLevel(value)) && (expected == null || isVisualSamplingLevel(expected))
    && readVisualSamplingLevel(value) === readVisualSamplingLevel(expected);
}

export const visualSamplingLevelLabels: Record<VisualSamplingLevel, string> = {
  quick: "省时",
  balanced: "均衡",
  detailed: "精细",
};
