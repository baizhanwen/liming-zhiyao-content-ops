export type ProjectContextSourceCandidate = {
  sourceType: string;
  sourceId?: string | null;
  title: string;
  text: string;
  score?: number;
  rank?: number;
  matchedTerms?: string[];
  confidence?: number | string | null;
  feedbackReuse?: boolean;
};

export type MappedProjectContextSource = {
  sourceType: "memory" | "knowledge" | "video_atom" | "strategy" | "inspiration";
  sourceId: string;
  title: string;
  text: string;
  organizationId: string;
  projectId: string;
  score?: number;
  rank?: number;
  matchedTerms?: string[];
  confidence?: number | string | null;
  feedbackReuse?: boolean;
};

export function mapProjectContextSources(
  sources: readonly ProjectContextSourceCandidate[],
  organizationId: string,
  projectId: string,
): MappedProjectContextSource[] {
  return sources.flatMap((source) => {
    if (!source.sourceId || !source.text.trim()) return [];
    if (!["memory", "knowledge", "video_atom", "strategy", "inspiration"].includes(source.sourceType)) return [];
    return [{
      sourceType: source.sourceType as MappedProjectContextSource["sourceType"],
      sourceId: source.sourceId,
      title: source.title,
      text: source.text,
      organizationId,
      projectId,
      score: source.score,
      rank: source.rank,
      matchedTerms: source.matchedTerms,
      confidence: source.confidence,
      ...(source.feedbackReuse ? { feedbackReuse: true } : {}),
    }];
  });
}

export function dedupeProjectGenerationSources<T extends { sourceType: string; sourceId: string }>(sources: readonly T[]): T[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.sourceType + ":" + source.sourceId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}