import contentTaxonomy from "../services/analyzer/liming_analyzer/resources/video-taxonomy.v1.json" with { type: "json" };

export const analysisProfiles = ["standard", "max"] as const;
export const historicalAnalysisProfiles = ["economy", "deep"] as const;
export type AnalysisProfile = typeof analysisProfiles[number];

/** Historical v9/v10 report settings. New submissions use the compact budgets below. */
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

export const unifiedAnalysisProfileBudgets = {
  standard: contentTaxonomy.budgets.standard.compact,
  max: contentTaxonomy.budgets.max.compact,
};

export const canonicalBudgetAssumptions = {
  charactersPerMinute: 320,
  secondsPerAsrSegment: 2,
  charactersPerBatch: 4_000,
  segmentsPerBatch: 48,
  defaultMaxOutputTokens: 6_000,
} as const;

export type UnifiedBudgetOptions = {
  /** The analyzer's configured per-request output limit, when known. */
  maxOutputTokens?: number;
  /** Supply the actual batch count after ASR; zero also covers an inapplicable/manual correction. */
  canonicalBatchCount?: number;
};

function durationForEstimate(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function configuredOutputLimit(options: UnifiedBudgetOptions) {
  const limit = options.maxOutputTokens ?? canonicalBudgetAssumptions.defaultMaxOutputTokens;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("maxOutputTokens must be a positive safe integer");
  return limit;
}

/** Match unified_analysis.py: only confirmed length exhaustion can trigger this second budget. */
function outputAttempts(profile: AnalysisProfile, ceiling: number, configuredLimit: number, moduleKey?: string) {
  const budget = unifiedAnalysisProfileBudgets[profile];
  const hardCap = Math.min(ceiling, configuredLimit);
  const initialByModule: Readonly<Record<string, number>> = budget.initial_output_tokens_by_module;
  const initial = moduleKey ? initialByModule[moduleKey] ?? budget.initial_output_tokens : budget.initial_output_tokens;
  let requested = Math.min(hardCap, initial);
  const attempts = [requested];
  for (let attempt = 1; attempt < Math.min(2, budget.max_api_attempts_per_module) && requested < hardCap; attempt += 1) {
    requested = Math.min(hardCap, Math.max(requested + 1_500, requested * 2));
    attempts.push(requested);
  }
  return attempts;
}

export function estimateUnifiedSourceTokens(durationSeconds: number) {
  const duration = durationForEstimate(durationSeconds);
  // Unlike legacy report selection, canonical correction does not discard a long transcript.
  return Math.max(1_200, Math.round(duration / 60 * canonicalBudgetAssumptions.charactersPerMinute + 600));
}

export function estimateCanonicalBatchCount(durationSeconds: number) {
  const duration = durationForEstimate(durationSeconds);
  const segments = Math.max(1, Math.ceil(duration / canonicalBudgetAssumptions.secondsPerAsrSegment));
  const characters = Math.max(1, Math.ceil(duration / 60 * canonicalBudgetAssumptions.charactersPerMinute));
  return Math.max(1, Math.ceil(segments / canonicalBudgetAssumptions.segmentsPerBatch),
    Math.ceil(characters / canonicalBudgetAssumptions.charactersPerBatch));
}

function classificationBudgets(profile: AnalysisProfile, configuredLimit: number) {
  const budget = unifiedAnalysisProfileBudgets[profile];
  return Object.entries(budget.modules).map(([key, ceiling]) => {
    const outputTokenBudgets = outputAttempts(profile, ceiling, configuredLimit, key);
    return {
      key, inputTokenLimit: budget.input_token_limit, outputTokenBudgets,
      initialRequestCount: 1, maximumRequestCount: outputTokenBudgets.length,
      initialTokensEstimate: budget.input_token_limit + outputTokenBudgets[0],
      retryTokensEstimate: budget.input_token_limit * outputTokenBudgets.length
        + outputTokenBudgets.reduce((sum, tokens) => sum + tokens, 0),
    };
  });
}

export function estimateContentClassificationMaximumTokens(profile: AnalysisProfile, options: UnifiedBudgetOptions = {}) {
  return classificationBudgets(profile, configuredOutputLimit(options)).reduce((sum, row) => sum + row.retryTokensEstimate, 0);
}

/**
 * Fresh v11 text-call planning estimate, not a measured bill or a guaranteed total cap.
 * Canonical batch count is inferred from duration until actual ASR is available.
 * Per-batch context allowance includes original text, OCR, timing and instructions;
 * canonical input has no corresponding hard backend cap. Each request/retry pays
 * for its input again, including source text reused by the four compact modules.
 * Image-model calls are separate and intentionally remain unknown here.
 */
export function estimateUnifiedAnalysisBudget(durationSeconds: number, profile: AnalysisProfile, options: UnifiedBudgetOptions = {}) {
  const configuredLimit = configuredOutputLimit(options);
  const budget = unifiedAnalysisProfileBudgets[profile];
  const batchCount = options.canonicalBatchCount ?? estimateCanonicalBatchCount(durationSeconds);
  if (!Number.isSafeInteger(batchCount) || batchCount < 0) throw new RangeError("canonicalBatchCount must be a nonnegative safe integer");
  const sourceTokensEstimate = estimateUnifiedSourceTokens(durationSeconds);
  // Reserve a profile-sized context envelope per estimated canonical batch. This
  // is an allowance for planning, not a claim that canonical inputs are capped.
  const inputTokensEstimate = batchCount ? Math.max(sourceTokensEstimate, batchCount * budget.input_token_limit) : 0;
  const outputTokenBudgets = batchCount ? outputAttempts(profile, configuredLimit, configuredLimit) : [];
  // Canonical v2 may spend its second and final batch call on directed repair,
  // even when the first response reached the configured output cap. Length
  // growth and that repair share this same two-call allowance.
  if (outputTokenBudgets.length === 1) outputTokenBudgets.push(outputTokenBudgets[0]);
  const canonical = {
    batchCountEstimate: batchCount,
    batchCountBasis: options.canonicalBatchCount === undefined ? "duration_assumption" as const : "provided" as const,
    inputTokensEstimate, inputTokensPerBatchAllowance: budget.input_token_limit,
    inputTokensAreHardCapped: false as const, outputTokenBudgets,
    initialRequestCount: batchCount,
    maximumRequestCount: batchCount * outputTokenBudgets.length,
    initialTokensEstimate: inputTokensEstimate + batchCount * (outputTokenBudgets[0] ?? 0),
    retryTokensEstimate: inputTokensEstimate * outputTokenBudgets.length
      + batchCount * outputTokenBudgets.reduce((sum, tokens) => sum + tokens, 0),
  };
  const modules = classificationBudgets(profile, configuredLimit);
  return {
    pipelineVersion: "analysis.v12" as const, profile,
    durationKnown: durationForEstimate(durationSeconds) > 0, configuredMaxOutputTokens: configuredLimit,
    sourceTokensEstimate, canonical, modules,
    initialInputTokensEstimate: canonical.inputTokensEstimate + modules.reduce((sum, row) => sum + row.inputTokenLimit, 0),
    retryInputTokensEstimate: canonical.inputTokensEstimate * canonical.outputTokenBudgets.length
      + modules.reduce((sum, row) => sum + row.inputTokenLimit * row.maximumRequestCount, 0),
    initialTextTokensEstimate: canonical.initialTokensEstimate + modules.reduce((sum, row) => sum + row.initialTokensEstimate, 0),
    retryTextTokensEstimate: canonical.retryTokensEstimate + modules.reduce((sum, row) => sum + row.retryTokensEstimate, 0),
    initialRequestCount: canonical.initialRequestCount + modules.length,
    maximumRequestCount: canonical.maximumRequestCount + modules.reduce((sum, row) => sum + row.maximumRequestCount, 0),
    visualTokens: null, includesImageModelCalls: false as const, isHardCap: false as const,
  };
}

export const additionalEvidenceFrameBudgets: Record<AnalysisProfile, number> = { standard: 30, max: 54 };

export function estimateRepresentativeFrames(durationSeconds: number, profile: AnalysisProfile) {
  const duration = durationForEstimate(durationSeconds);
  const interpolate = (minimum: number, maximum: number, ratio: number) => Math.round(minimum + (maximum - minimum) * Math.max(0, Math.min(1, ratio)));
  if (duration <= 600) return profile === "max" ? interpolate(24, 48, duration / 600) : interpolate(12, 24, duration / 600);
  if (duration <= 1_800) return profile === "max" ? interpolate(60, 120, (duration - 600) / 1_200) : interpolate(24, 60, (duration - 600) / 1_200);
  return profile === "max" ? interpolate(120, 180, (duration - 1_800) / 1_800) : interpolate(60, 90, (duration - 1_800) / 1_800);
}

export function estimateMediaSourceTokens(durationSeconds: number, profile: AnalysisProfile) {
  const estimated = estimateUnifiedSourceTokens(durationSeconds);
  return Math.min(estimated, analysisProfileBudgets[profile].sourceTokens);
}

/** Numeric compatibility export: v11 text estimate including possible length retries, excluding vision. */
export function estimateAnalysisMaximumTokens(durationSeconds: number, profile: AnalysisProfile, options: UnifiedBudgetOptions = {}) {
  return estimateUnifiedAnalysisBudget(durationSeconds, profile, options).retryTextTokensEstimate;
}

export function normalizeAnalysisProfile(value: unknown): AnalysisProfile {
  return value === "max" ? "max" : "standard";
}
