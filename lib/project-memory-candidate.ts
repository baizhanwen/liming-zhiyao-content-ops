import { PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND } from "./project-memory-taxonomy.ts";

export type MemoryCandidateDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null | undefined>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>): Promise<unknown>;
};

export type MemoryCandidateInput = {
  organizationId: string;
  projectId: string;
  userId: string;
  canonicalKey: string;
  title: string;
  content: string;
  value?: unknown;
  sourceType: string;
  sourceId?: string | null;
  quote?: string | null;
  evidence?: Array<{ sourceType: string; sourceId: string; quote?: string | null; relevance?: number | null }>;
};

async function sha256HexText(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createMemoryCandidateWithDb(db: MemoryCandidateDatabase, input: MemoryCandidateInput) {
  const now = new Date().toISOString();
  const contentHash = await sha256HexText(input.content);
  const existing = await db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM project_memory_items WHERE organization_id = ? AND project_id = ? AND canonical_key = ?").bind(input.organizationId, input.projectId, input.canonicalKey).first<{ revision: number }>();
  const revision = Number(existing?.revision ?? 0) + 1;
  const id = crypto.randomUUID();
  const writes = [db.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, input.organizationId, input.projectId, input.canonicalKey, PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND, input.title, input.content, JSON.stringify(input.value ?? {}), input.sourceType, input.sourceId ?? null, revision, contentHash, input.userId, now, now)];
  const evidence = input.evidence?.length ? input.evidence : [{ sourceType: input.sourceType, sourceId: input.sourceId ?? id, quote: input.quote ?? null, relevance: 100 }];
  for (const item of evidence.slice(0, 20)) {
    if (!item.sourceType || !item.sourceId) continue;
    writes.push(db.prepare("INSERT INTO project_memory_evidence (id, organization_id, project_id, memory_item_id, source_type, source_id, quote, relevance, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), input.organizationId, input.projectId, id, item.sourceType, item.sourceId, item.quote ?? null, item.relevance ?? 100, input.userId, now));
  }
  await db.batch(writes);
  return { id, revision, status: "candidate" as const, contentHash };
}