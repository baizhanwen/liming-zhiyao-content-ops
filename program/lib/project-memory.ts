import { getD1, sha256Hex } from "../db/runtime";
import { retrieveAuthorizedProjectKnowledge, type ProjectKnowledgeRow } from "./project-knowledge-retrieval";
import { createMemoryCandidateWithDb, type MemoryCandidateInput } from "./project-memory-candidate";

export type MemoryStatus = "candidate" | "confirmed" | "rejected" | "superseded" | "expired";
export type MemorySource = { sourceType: string; sourceId?: string | null; title: string; text: string; category?: string; memoryItemId?: string; revision?: number; contentHash?: string; score?: number; rank?: number; matchedTerms?: string[]; confidence?: number | string | null; originSourceType?: string | null; originSourceId?: string | null; feedbackReuse?: boolean };
export type RetrievedProjectContext = { sources: MemorySource[]; memorySnapshotId: string; retrievalRunId: string; budget: number };
export { transitionProjectMemory } from "./project-memory-state";
export type { MemoryTransitionResult } from "./project-memory-state";

export async function retrieveProjectContext(input: { organizationId: string; projectId: string; userId: string; purpose: string; query?: string; explicitBenchmarkEntryIds?: string[]; maxCharacters?: number }): Promise<RetrievedProjectContext> {
  const db = getD1(); const budget = Math.max(4_000, Math.min(80_000, input.maxCharacters ?? 24_000)); const now = new Date().toISOString();
  const [knowledge, strategy, atoms, inspirations] = await Promise.all([
    db.prepare("SELECT k.id, k.organization_id, k.project_id, k.title, v.body FROM knowledge_items k INNER JOIN knowledge_item_versions v ON v.item_id = k.id AND v.version = k.current_version AND v.organization_id = k.organization_id AND v.project_id = k.project_id WHERE k.organization_id = ? AND k.project_id = ? AND k.status = 'confirmed' AND k.deleted_at IS NULL ORDER BY k.updated_at DESC LIMIT 100").bind(input.organizationId, input.projectId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, name, positioning, persona, target_audience, pain_points_json, pillars_json, style_notes, conversion_path, objectives_json FROM content_strategies WHERE organization_id = ? AND project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1").bind(input.organizationId, input.projectId).first<Record<string, unknown>>(),
    db.prepare("SELECT a.id, a.organization_id, a.atom_key, a.atom_type, a.title, a.content, a.source_locator_json, a.confidence, a.report_hash FROM video_knowledge_atoms a INNER JOIN project_video_references refs ON refs.library_entry_id = a.library_entry_id AND refs.organization_id = a.organization_id AND refs.project_id = ? AND refs.status = 'active' WHERE a.organization_id = ? AND a.status = 'active' AND (refs.purpose = 'analysis' OR refs.purpose = 'benchmark') ORDER BY COALESCE(a.confidence, 0) DESC, a.updated_at DESC LIMIT 300").bind(input.projectId, input.organizationId).all<Record<string, unknown>>(),
    db.prepare("SELECT id, title, core_insight, evidence_json, confidence FROM project_inspiration_cards WHERE organization_id = ? AND project_id = ? AND status = 'confirmed' AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 80").bind(input.organizationId, input.projectId, now).all<Record<string, unknown>>(),
  ]);
  const rows: ProjectKnowledgeRow[] = [
    ...knowledge.results.map((row) => ({ sourceType: "knowledge" as const, sourceId: String(row.id), organizationId: String(row.organization_id ?? input.organizationId), projectId: String(row.project_id ?? input.projectId), title: String(row.title ?? "品牌知识"), text: String(row.body ?? ""), status: "confirmed" })),
    ...(strategy ? [{ sourceType: "strategy" as const, sourceId: String(strategy.id), organizationId: input.organizationId, projectId: input.projectId, title: String(strategy.name ?? "当前内容策略"), text: JSON.stringify(strategy), status: "active", kind: "hard" as const }] : []),
    ...atoms.results.map((row) => ({ sourceType: "video_atom" as const, sourceId: String(row.id), organizationId: String(row.organization_id ?? input.organizationId), projectId: input.projectId, title: String(row.title ?? row.atom_type ?? "视频知识原子"), text: String(row.content ?? ""), status: "active", confidence: Number(row.confidence ?? 0) })),
    ...inspirations.results.map((row) => ({ sourceType: "inspiration" as const, sourceId: String(row.id), organizationId: input.organizationId, projectId: input.projectId, title: String(row.title ?? "已确认灵感"), text: String(row.core_insight ?? "") + "\n证据：" + String(row.evidence_json ?? "[]"), status: "confirmed", confidence: Number(row.confidence ?? 0) })),
  ];
  const ranked = retrieveAuthorizedProjectKnowledge({ rows, organizationId: input.organizationId, projectId: input.projectId, query: input.query, now, maxCharacters: budget });
  const selected: MemorySource[] = ranked.map((row) => ({ sourceType: row.sourceType, sourceId: row.sourceId, category: row.category, memoryItemId: row.sourceType === "memory" ? row.sourceId : undefined, revision: row.revision, contentHash: row.contentHash, score: row.score, rank: row.rank, matchedTerms: row.matchedTerms, confidence: row.confidence, originSourceType: row.originSourceType, originSourceId: row.originSourceId, feedbackReuse: row.feedbackReuse, title: row.title, text: row.text }));
  const selectedMemory = ranked.filter((row) => row.sourceType === "memory");
  const snapshotId = crypto.randomUUID(); const retrievalRunId = crypto.randomUUID(); const snapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(selectedMemory.map((item) => [item.sourceId, item.revision, item.contentHash]))));
  const statements = [db.prepare("INSERT INTO project_memory_snapshots (id, organization_id, project_id, purpose, query, snapshot_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(snapshotId, input.organizationId, input.projectId, input.purpose, input.query?.trim() || null, snapshotHash, input.userId, now)];
  selectedMemory.forEach((item, index) => statements.push(db.prepare("INSERT INTO project_memory_snapshot_items (id, snapshot_id, memory_item_id, revision, rank, content_hash) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), snapshotId, item.sourceId, item.revision ?? 1, index, item.contentHash ?? "")));
  await db.batch(statements);
  return { sources: selected, memorySnapshotId: snapshotId, retrievalRunId, budget };
}
export async function createMemoryCandidate(input: MemoryCandidateInput) {
  return createMemoryCandidateWithDb(getD1(), input);
}
