import { estimateRewriteUsage, type ScriptRewriteVariant } from "./script-rewrite.ts";
import type { RewriteBrandMapping, RewriteBrandMode } from "./script-rewrite-adaptation";
import type { RewriteBrandSource } from "./script-rewrite-brand";

export type RewriteAdaptationOptions = {
  mode: RewriteBrandMode;
  goal: string;
  audience: string;
  scenario: string;
  brandStamp?: string;
};

export type RewriteAdaptationSnapshot = RewriteAdaptationOptions & {
  targetName: string | null;
  sources: RewriteBrandSource[];
  mappings: RewriteBrandMapping[];
  unresolved: string[];
  qualityNotes: string[];
  inheritedFromVersionId?: string;
};

export function readRewriteOptions(value: unknown): RewriteAdaptationOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请重新选择品牌处理方式。");
  const input = value as Record<string, unknown>;
  const { mode } = input;
  if (mode !== "preserve" && mode !== "current_brand" && mode !== "neutral") throw new Error("品牌处理方式无效。");
  const field = (key: string, max: number) => {
    const text = input[key] ?? "";
    if (typeof text !== "string" || text.trim().length > max) throw new Error("改写要求过长或格式无效，请缩短后重试。");
    return text.trim();
  };
  return { mode, goal: field("goal", 500), audience: field("audience", 300), scenario: field("scenario", 300),
    ...(mode === "current_brand" && input.brandStamp !== undefined ? { brandStamp: field("brandStamp", 4096) } : {}) };
}

export function parseRewriteSnapshot(json: string | null): RewriteAdaptationSnapshot | null {
  if (json === null) return null;
  const snapshot = JSON.parse(json) as RewriteAdaptationSnapshot;
  readRewriteOptions(snapshot);
  if (!Array.isArray(snapshot.sources) || !Array.isArray(snapshot.mappings)) throw new Error("品牌适配记录不完整，请重新生成。");
  return snapshot;
}

export function estimateAdaptedRewriteUsage(source: string, variants: ScriptRewriteVariant[], mode: RewriteBrandMode | null) {
  const base = estimateRewriteUsage(source, variants);
  if (!mode) return base;
  const plans = mode === "preserve" ? 0 : variants.length;
  const reviews = variants.length;
  return { ...base, callCount: base.callCount + plans + reviews,
    maximumCallCount: base.maximumCallCount + plans * 2 + reviews * 4,
    estimatedInputTokens: base.estimatedInputTokens + plans * (base.sourceTokens + 1400) + reviews * (2 * base.sourceTokens + 1600),
    maximumOutputTokens: base.maximumOutputTokens + plans * 9000 + reviews * (7500 + Math.min(16000, 2 * source.length + 1600)) };
}
