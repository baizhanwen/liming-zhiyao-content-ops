import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { createMemoryCandidateWithDb } from "../../../../lib/project-memory-candidate";
import { transitionProjectMemory } from "../../../../lib/project-memory-state";
import { readRequestIdentity } from "../../../../lib/request-auth";

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function scope(request: Request, memoryId: string) {
  const identity = await readRequestIdentity(request);
  if (!identity) return { error: apiError("AUTH_REQUIRED", "请先登录后再管理账号记忆。", 401) } as const;
  const url = new URL(request.url);
  const organizationId = text(url.searchParams.get("organizationId"), 100);
  const projectId = text(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId || !memoryId) return { error: apiError("MEMORY_SCOPE_REQUIRED", "缺少账号记忆范围。", 400) } as const;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
  if (!access) return { error: apiError("ACCESS_DENIED", "无权访问该项目账号记忆。", 403) } as const;
  return { identity, organizationId, projectId, access, memoryId } as const;
}

export async function GET(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const { memoryId } = await context.params;
  const current = await scope(request, memoryId);
  if ("error" in current) return current.error;
  try {
    const db = getD1();
    const item = await db.prepare("SELECT canonical_key FROM project_memory_items WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1").bind(current.memoryId, current.organizationId, current.projectId).first<{ canonical_key: string }>();
    if (!item) return apiError("MEMORY_NOT_FOUND", "账号记忆不存在。", 404);
    const rows = await db.prepare("SELECT m.*, (SELECT json_group_array(json_object('id', e.id, 'sourceType', e.source_type, 'sourceId', e.source_id, 'quote', e.quote, 'relevance', e.relevance)) FROM project_memory_evidence e WHERE e.memory_item_id = m.id) AS evidence_json FROM project_memory_items m WHERE m.organization_id = ? AND m.project_id = ? AND m.canonical_key = ? ORDER BY m.revision DESC").bind(current.organizationId, current.projectId, item.canonical_key).all();
    return Response.json({ canonicalKey: item.canonical_key, history: rows.results, canWrite: canWriteProjectAccess(current.access) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const { memoryId } = await context.params;
  const current = await scope(request, memoryId);
  if ("error" in current) return current.error;
  try {
    if (!canWriteProjectAccess(current.access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能编辑账号记忆。", 403);
    const payload = await request.json() as Record<string, unknown>;
    const title = text(payload.title, 160); const content = text(payload.content, 20_000); const sourceType = "manual_correction"; const sourceId = current.memoryId; const quote = text(payload.quote, 4_000) || null;
    if (title.length < 2 || content.length < 2) return apiError("MEMORY_FIELDS_REQUIRED", "账号记忆需要标题和内容。", 400);
    const db = getD1(); const existing = await db.prepare("SELECT canonical_key, status FROM project_memory_items WHERE id = ? AND organization_id = ? AND project_id = ? LIMIT 1").bind(current.memoryId, current.organizationId, current.projectId).first<{ canonical_key: string; status: string }>();
    if (!existing) return apiError("MEMORY_NOT_FOUND", "账号记忆不存在。", 404);
    if (["superseded", "expired"].includes(existing.status)) return apiError("MEMORY_NOT_EDITABLE", "历史或已禁用记忆不能继续编辑，请从当前版本编辑。", 409);
    const user = await ensureUser(current.identity);
    const evidenceRows = await db.prepare("SELECT source_type, source_id, quote, relevance FROM project_memory_evidence WHERE memory_item_id = ? AND organization_id = ? AND project_id = ?").bind(current.memoryId, current.organizationId, current.projectId).all<{ source_type: string; source_id: string; quote: string | null; relevance: number | null }>();
    const evidence = evidenceRows.results.map((item) => ({ sourceType: item.source_type, sourceId: item.source_id, quote: item.quote, relevance: item.relevance }));
    evidence.push({ sourceType, sourceId, quote, relevance: 100 });
    const result = await createMemoryCandidateWithDb(db, { organizationId: current.organizationId, projectId: current.projectId, userId: user.id, canonicalKey: existing.canonical_key, title, content, value: payload.value, sourceType, sourceId, quote, evidence });
    const now = new Date().toISOString();
    const savedStatus = await transitionProjectMemory({ db, memoryId: result.id, organizationId: current.organizationId, projectId: current.projectId, userId: user.id, action: "confirm", now });
    if (!savedStatus.ok) {
      await db.prepare("UPDATE project_memory_items SET status = 'expired', updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'candidate'").bind(now, result.id, current.organizationId, current.projectId).run();
      return apiError("MEMORY_EDIT_CONFIRM_FAILED", "修订没有成功替换当前项目记忆，请刷新后重试。", 409);
    }
    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'project_memory.edited', 'project_memory_item', ?, ?, ?)").bind(crypto.randomUUID(), current.organizationId, current.projectId, user.id, result.id, JSON.stringify({ previousId: current.memoryId, canonicalKey: existing.canonical_key, revision: result.revision }), now).run();
    return Response.json({ item: { ...result, status: savedStatus.status }, previousId: current.memoryId }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ memoryId: string }> }) {
  const { memoryId } = await context.params;
  const current = await scope(request, memoryId);
  if ("error" in current) return current.error;
  try {
    if (!canWriteProjectAccess(current.access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能禁用账号记忆。", 403);
    const user = await ensureUser(current.identity); const now = new Date().toISOString();
    const result = await getD1().prepare("UPDATE project_memory_items SET status = 'expired', updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status IN ('candidate', 'confirmed', 'rejected')").bind(now, current.memoryId, current.organizationId, current.projectId).run();
    if (!result.meta.changes) return apiError("MEMORY_NOT_DISABLABLE", "账号记忆不存在或当前状态不可禁用。", 409);
    await getD1().prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'project_memory.disabled', 'project_memory_item', ?, ?, ?)").bind(crypto.randomUUID(), current.organizationId, current.projectId, user.id, current.memoryId, JSON.stringify({ status: "expired" }), now).run();
    return Response.json({ id: current.memoryId, status: "expired" });
  } catch (error) { return errorResponse(error); }
}
