import { authorizedKnowledgeSearchTerms } from "./authorized-knowledge.ts";
import { coreContentStrategy, type CoreContentStrategy } from "./content-strategy-policy.ts";

export type TopicBackground = CoreContentStrategy;
export type TopicReferenceRecommendation = { id: string; title: string; category: string; matchedTerms: string[] };
export type TopicSourcePreview = { sourceType: string; sourceId: string; title: string; text: string; characterCount: number };

export function topicBackground(row: Record<string, string | null> | null): TopicBackground | null {
  return coreContentStrategy(row);
}

export function recommendTopicReferences(query: string, rows: { id: string; title: string; category: string; body: string }[]): TopicReferenceRecommendation[] {
  const terms = authorizedKnowledgeSearchTerms(query, 24);
  return rows.map(row => {
    const content = `${row.title}\n${row.body}`.normalize("NFKC").toLowerCase();
    const matchedTerms = terms.filter(term => content.includes(term));
    return { id: row.id, title: row.title, category: row.category, matchedTerms, score: matchedTerms.reduce((sum, term) => sum + term.length, 0) };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 5).map(({ id, title, category, matchedTerms }) => ({ id, title, category, matchedTerms: matchedTerms.slice(0, 5) }));
}
