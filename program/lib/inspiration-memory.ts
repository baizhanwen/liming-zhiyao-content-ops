import { readCurrentProjectMemoriesWithDb, type ProjectAssistantDatabase } from "./project-memory-events.ts";
import { authorizedKnowledgeSearchTerms } from "./authorized-knowledge.ts";

export type InspirationMemory = { id: string; title: string; content: string; revision: number; contentHash: string; evidence: Array<{ sourceType: string; sourceId: string; quote: string | null }> };

// Only the inspiration assistant consumes this library. Other generation paths
// must not call the general project-context retriever to expand it implicitly.
export async function readInspirationMemories(db: ProjectAssistantDatabase, scope: { organizationId: string; projectId: string; query?: string }): Promise<InspirationMemory[]> {
  const rows = await readCurrentProjectMemoriesWithDb(db, scope);
  const terms = authorizedKnowledgeSearchTerms(scope.query || "", 20);
  const ranked = rows.map(row => ({ row, score: terms.reduce((sum, term) => sum + (`${row.title}\n${row.content}`.toLowerCase().includes(term.toLowerCase()) ? term.length : 0), 0) })).sort((a, b) => b.score - a.score);
  const relevant = ranked.some(item => item.score > 0) ? ranked.filter(item => item.score > 0) : ranked;
  const selected = relevant.slice(0, 12);
  if (!selected.length) return [];
  const evidence = await db.prepare(`SELECT memory_item_id, source_type, source_id, quote FROM project_memory_evidence WHERE organization_id = ? AND project_id = ? AND memory_item_id IN (${selected.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 120`)
    .bind(scope.organizationId, scope.projectId, ...selected.map(item => item.row.id)).all<{ memory_item_id: string; source_type: string; source_id: string; quote: string | null }>();
  const perItem = Math.floor(16000 / selected.length);
  return selected.map(({ row }) => ({
    id: row.id, title: row.title, content: row.content.slice(0, Math.min(3000, perItem)), revision: row.revision, contentHash: row.contentHash,
    evidence: evidence.results.filter(item => item.memory_item_id === row.id).slice(0, 5).map(item => ({ sourceType: item.source_type, sourceId: item.source_id, quote: item.quote?.slice(0, 1000) || null })),
  }));
}
