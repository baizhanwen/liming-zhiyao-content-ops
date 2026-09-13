export type InspirationCardStatus = "candidate" | "confirmed" | "rejected" | "superseded" | "archived";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T>(): Promise<T | null | undefined>;
};

type Database = {
  prepare(sql: string): Prepared;
  batch(statements: Prepared[]): Promise<Array<{ meta: { changes: number } }>>;
};

export type InspirationTransitionResult = { ok: true; status: "confirmed" | "rejected" } | { ok: false; reason: "not_found" | "not_actionable" | "state_changed" };

export async function transitionInspirationCard(input: { db: Database; cardId: string; organizationId: string; projectId: string; userId: string; action: "confirm" | "reject"; now: string }): Promise<InspirationTransitionResult> {
  const card = await input.db.prepare("SELECT id, canonical_key, status FROM project_inspiration_cards WHERE id = ? AND organization_id = ? AND project_id = ?").bind(input.cardId, input.organizationId, input.projectId).first<{ id: string; canonical_key: string; status: InspirationCardStatus }>();
  if (!card) return { ok: false, reason: "not_found" };
  if (input.action === "reject" && card.status !== "candidate") return { ok: false, reason: "not_actionable" };
  if (input.action === "confirm" && !["candidate", "confirmed"].includes(card.status)) return { ok: false, reason: "not_actionable" };
  const writes = input.action === "confirm" ? [
    input.db.prepare("UPDATE project_inspiration_cards SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE organization_id = ? AND project_id = ? AND canonical_key = ? AND status = 'confirmed' AND id != ?").bind(input.cardId, input.now, input.organizationId, input.projectId, card.canonical_key, input.cardId),
    input.db.prepare("UPDATE project_inspiration_cards SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('candidate', 'confirmed')").bind(input.userId, input.now, input.now, input.cardId, input.organizationId, input.projectId),
  ] : [
    input.db.prepare("UPDATE project_inspiration_cards SET status = 'rejected', rejected_by = ?, rejected_at = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'candidate'").bind(input.userId, input.now, input.now, input.cardId, input.organizationId, input.projectId),
  ];
  const results = await input.db.batch(writes);
  if (!results[results.length - 1]?.meta.changes) return { ok: false, reason: "state_changed" };
  return { ok: true, status: input.action === "confirm" ? "confirmed" : "rejected" };
}