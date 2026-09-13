import type { InspirationMemory } from "./inspiration-memory.ts";
export const PROJECT_ASSISTANT_PROMPT_VERSION = "project-assistant.v13-inspiration-only";

export class ProjectAssistantInvalidResponseError extends Error {
  readonly code = "PROJECT_ASSISTANT_INVALID_RESPONSE";
}

export type ProjectAssistantEvidence = {
  sourceType: string;
  sourceId: string;
  quote: string | null;
};

export type ProjectAssistantMemoryOperation = {
  operation: "add" | "revise" | "merge" | "retire" | "noop";
  canonicalKey: string | null;
  title: string | null;
  content: string | null;
  confidence: number;
  evidence: ProjectAssistantEvidence[];
  mergeFromKeys: string[];
  reason: string;
};

export type ProjectAssistantCitation = {
  benchmarkId: string;
  quote: string | null;
};

export type ProjectAssistantRecommendation = {
  memoryIds?: string[];
  memorySources?: InspirationMemory[];
  title: string;
  coreInsight: string;
  applicableScenarios: string[];
  excludedScenarios: string[];
  tags: string[];
  confidence: number;
  benchmarkIds: string[];
};

export type ProjectAssistantChatResponse = {
  memoryCitations: Array<{ memoryId: string; quote: string | null }>;
  reply: string;
  citations: ProjectAssistantCitation[];
  recommendations: ProjectAssistantRecommendation[];
  memoryOperations: ProjectAssistantMemoryOperation[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stringList(value: unknown, limit: number, itemLimit: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => text(item, itemLimit)).filter(Boolean))).slice(0, limit);
}

export function normalizeProjectAssistantConfidence(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function canonicalKey(value: unknown) {
  return text(value, 160).replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
}

function stripJsonFence(content: string) {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export function parseProjectAssistantJson(content: string): Record<string, unknown> {
  const candidate = stripJsonFence(content);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const parsed = JSON.parse(candidate.slice(first, last + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    }
  }
  throw new ProjectAssistantInvalidResponseError("项目助理模型没有返回有效的 JSON 对象。");
}

function parseEvidence(value: unknown, fallback?: ProjectAssistantEvidence) {
  const rows = Array.isArray(value) ? value : [];
  const parsed = rows.map((item) => {
    const row = record(item);
    return {
      sourceType: text(row.sourceType ?? row.source_type, 60),
      sourceId: text(row.sourceId ?? row.source_id, 180),
      quote: text(row.quote, 4000) || null,
    };
  }).filter((item) => item.sourceType && item.sourceId).slice(0, 20);
  if (!parsed.length && fallback?.sourceType && fallback.sourceId) return [fallback];
  return parsed;
}

export function normalizeMemoryOperations(
  value: unknown,
  fallbackEvidence?: ProjectAssistantEvidence,
): ProjectAssistantMemoryOperation[] {
  const rows = Array.isArray(value) ? value : [];
  const operations = rows.map((item) => {
    const row = record(item);
    const rawOperation = text(row.operation ?? row.action, 20).toLowerCase();
    const operation = ["add", "revise", "merge", "retire", "noop"].includes(rawOperation)
      ? rawOperation as ProjectAssistantMemoryOperation["operation"]
      : "noop";
    const key = canonicalKey(row.canonicalKey ?? row.canonical_key) || null;
    const operationTitle = text(row.title, 160) || null;
    const operationContent = text(row.content, 20_000) || null;
    if (operation !== "noop" && !key) return null;
    if (["add", "revise", "merge"].includes(operation) && (!operationTitle || !operationContent)) return null;
    return {
      operation,
      canonicalKey: key,
      title: operationTitle,
      content: operationContent,
      confidence: normalizeProjectAssistantConfidence(row.confidence),
      evidence: parseEvidence(row.evidence, fallbackEvidence),
      mergeFromKeys: stringList(row.mergeFromKeys ?? row.merge_from_keys, 20, 160),
      reason: text(row.reason, 2000) || "模型未补充操作理由。",
    };
  }).filter((item): item is ProjectAssistantMemoryOperation => Boolean(item)).slice(0, 30);
  return operations.length ? operations : [{
    operation: "noop",
    canonicalKey: null,
    title: null,
    content: null,
    confidence: 100,
    evidence: fallbackEvidence ? [fallbackEvidence] : [],
    mergeFromKeys: [],
    reason: "没有识别到需要更新的稳定项目记忆。",
  }];
}

export function parseMemoryOperationsResponse(
  content: string,
  fallbackEvidence?: ProjectAssistantEvidence,
) {
  const root = parseProjectAssistantJson(content);
  return normalizeMemoryOperations(root.memoryOperations ?? root.memory_operations ?? root.operations, fallbackEvidence);
}

export function parseProjectAssistantChatResponse(content: string): ProjectAssistantChatResponse {
  const root = parseProjectAssistantJson(content);
  const reply = text(root.reply ?? root.answer, 30_000);
  if (!reply) throw new ProjectAssistantInvalidResponseError("项目助理模型没有返回对话正文。");
  const citations = (Array.isArray(root.citations) ? root.citations : []).map((item) => {
    const row = record(item);
    return { benchmarkId: text(row.benchmarkId ?? row.benchmark_id ?? row.sourceId ?? row.source_id, 160), quote: text(row.quote, 2000) || null };
  }).filter((item) => item.benchmarkId).slice(0, 40);
  const recommendations = (Array.isArray(root.recommendations) ? root.recommendations : []).map((item): ProjectAssistantRecommendation | null => {
    const row = record(item);
    const title = text(row.title, 160);
    const coreInsight = text(row.coreInsight ?? row.core_insight, 20_000);
    if (title.length < 2 || coreInsight.length < 10) return null;
    return {
      title,
      coreInsight,
      applicableScenarios: stringList(row.applicableScenarios ?? row.applicable_scenarios, 20, 500),
      excludedScenarios: stringList(row.excludedScenarios ?? row.excluded_scenarios, 20, 500),
      tags: stringList(row.tags, 30, 80),
      confidence: normalizeProjectAssistantConfidence(row.confidence, 70),
      benchmarkIds: stringList(row.benchmarkIds ?? row.benchmark_ids ?? row.sourceIds ?? row.source_ids, 30, 160),
      memoryIds: stringList(row.memoryIds, 12, 160),
    };
  }).filter((item): item is ProjectAssistantRecommendation => Boolean(item)).slice(0, 12);
  return {
    reply,
    citations,
    memoryCitations: (Array.isArray(root.memoryCitations) ? root.memoryCitations : []).map(item => {
      const row = record(item);
      return { memoryId: text(row.memoryId, 160), quote: text(row.quote, 2000) || null };
    }).filter(item => item.memoryId).slice(0, 12),
    recommendations,
    memoryOperations: normalizeMemoryOperations(root.memoryOperations ?? root.memory_operations ?? root.operations),
  };
}
