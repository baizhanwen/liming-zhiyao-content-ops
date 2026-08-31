export type ProjectVideoReferenceAction = "created" | "reactivated" | "already_active";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T>(): Promise<T | null | undefined>;
  run(): Promise<{ meta: { changes: number } }>;
};
type Database = {
  prepare(sql: string): Prepared;
};

export async function upsertProjectVideoReference(db: Database, input: { organizationId: string; projectId: string; libraryEntryId: string; purpose: "analysis" | "benchmark"; userId: string; now: string }) {
  const existing = await db.prepare("SELECT id, status FROM project_video_references WHERE organization_id = ? AND project_id = ? AND library_entry_id = ? AND purpose = ? LIMIT 1").bind(input.organizationId, input.projectId, input.libraryEntryId, input.purpose).first<{ id: string; status: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const result = await db.prepare("INSERT INTO project_video_references (id, organization_id, project_id, library_entry_id, purpose, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(project_id, library_entry_id, purpose) DO UPDATE SET status = 'active', revoked_by = NULL, revoked_at = NULL, revoke_reason = NULL").bind(id, input.organizationId, input.projectId, input.libraryEntryId, input.purpose, input.userId, input.now).run();
  if (!result.meta.changes) throw new Error("PROJECT_VIDEO_REFERENCE_NOT_WRITTEN");
  const action: ProjectVideoReferenceAction = !existing ? "created" : existing.status === "revoked" ? "reactivated" : "already_active";
  return { id, action };
}