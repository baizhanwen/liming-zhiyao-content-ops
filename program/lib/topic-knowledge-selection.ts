/** Only persisted explicit selections count; old inferred citations are not consent. */
export function topicKnowledgeSelection(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map(id => id.trim()))] : [];
  } catch { return []; }
}
