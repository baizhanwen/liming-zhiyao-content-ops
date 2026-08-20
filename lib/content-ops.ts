import type { ProjectAccess } from "../db/runtime";

export const knowledgeCategories = ["brand_story", "founder", "case_study", "customer_question", "sales_script", "high_performing_copy", "industry_term", "compliance", "brand_voice", "client_preference", "other"] as const;
export const knowledgeSourceTypes = ["manual", "document", "url", "client_feedback", "analysis"] as const;
export type KnowledgeCategory = (typeof knowledgeCategories)[number];
export type KnowledgeSourceType = (typeof knowledgeSourceTypes)[number];

export function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function canManageProjectKnowledge(access: ProjectAccess) {
  return access.organizationRole === "admin" || (access.organizationRole !== "readonly" && (access.projectRole === "owner" || access.projectRole === "planner"));
}

export function cleanStringList(value: unknown, maxItems = 20) {
  if (!Array.isArray(value)) return null;
  const cleaned = value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 200)] : []).slice(0, maxItems);
  return cleaned.length ? cleaned : null;
}

export function parseJsonValue(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}
