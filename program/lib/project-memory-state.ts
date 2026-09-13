export type MemoryStatus = "candidate" | "confirmed" | "rejected" | "superseded" | "expired";
export type MemoryTransitionResult = { ok: true; status: "confirmed" | "rejected" } | { ok: false; reason: "not_found" | "not_actionable" | "state_changed" };

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T>(): Promise<T | null | undefined>;
};
type Database = {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<Array<{ meta: { changes: number } }>>;
};

export async function transitionProjectMemory(input: { db: Database; memoryId: string; organizationId: string; projectId: string; userId: string; action: "confirm" | "reject"; now: string }): Promise<MemoryTransitionResult> {
  const item = await input.db.prepare("SELECT id, canonical_key, status FROM project_memory_items WHERE id = ? AND organization_id = ? AND project_id = ?").bind(input.memoryId, input.organizationId, input.projectId).first<{ id: string; canonical_key: string; status: MemoryStatus }>();
  if (!item) return { ok: false, reason: "not_found" };
  if (input.action === "reject" && item.status !== "candidate") return { ok: false, reason: "not_actionable" };
  if (input.action === "confirm" && !["candidate", "confirmed"].includes(item.status)) return { ok: false, reason: "not_actionable" };
  const writes = input.action === "confirm" ? [
    input.db.prepare("UPDATE project_memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND canonical_key = ? AND status IN ('candidate', 'confirmed') AND id != ?").bind(input.memoryId, input.now, input.organizationId, input.projectId, item.canonical_key, input.memoryId),
    input.db.prepare("UPDATE project_memory_items SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('candidate', 'confirmed')").bind(input.userId, input.now, input.now, input.memoryId, input.organizationId, input.projectId),
  ] : [
    input.db.prepare("UPDATE project_memory_items SET status = 'rejected', rejected_by = ?, rejected_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'candidate'").bind(input.userId, input.now, input.now, input.memoryId, input.organizationId, input.projectId),
  ];
  const results = await input.db.batch(writes);
  const target = results[results.length - 1];
  if (!target?.meta.changes) return { ok: false, reason: "state_changed" };
  return { ok: true, status: input.action === "confirm" ? "confirmed" : "rejected" };
}