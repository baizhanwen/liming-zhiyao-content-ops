import { ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { allowedWorkflowTransition, contentStatuses, workflowTransitionSchema, type ContentStatus } from "../../../../../lib/content-workflow";
import { PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND } from "../../../../../lib/project-memory-taxonomy";
import { readRequestIdentity } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新内容状态。", 401);
  try {
    const parsed = workflowTransitionSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_WORKFLOW_TRANSITION", parsed.error.issues[0]?.message || "状态流转参数无效。", 400);
    const { organizationId, projectId, toStatus, note } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare(`
      SELECT c.id, c.title, c.status, c.current_version, v.id AS version_id, v.generation_mode
      FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id
      WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL
    `).bind(contentId, organizationId, projectId).first<{ id: string; title: string; status: string; current_version: number; version_id: string; generation_mode: string }>();
    if (!item || !contentStatuses.includes(item.status as ContentStatus)) return apiError("CONTENT_NOT_FOUND", "内容不存在或状态无效。", 404);
    const fromStatus = item.status as ContentStatus;
    if (!allowedWorkflowTransition(access, fromStatus, toStatus)) return apiError("WORKFLOW_TRANSITION_DENIED", "当前角色不能执行这次状态流转。", 403);
    if (toStatus === "internal_review" && item.generation_mode === "scaffold") return apiError("CONTENT_SCRIPT_REQUIRED", "这份内容尚未生成口播稿，请完成生成或手动写稿并保存后再提交审核。", 409);
    const pendingStage = fromStatus === "internal_review" ? "internal" : fromStatus === "client_review" ? "client" : null;
    const pendingReview = pendingStage ? await db.prepare("SELECT id, review_stage, round FROM content_reviews WHERE organization_id = ? AND project_id = ? AND content_item_id = ? AND content_version_id = ? AND review_stage = ? AND decision = 'pending' ORDER BY round DESC LIMIT 1").bind(organizationId, projectId, contentId, item.version_id, pendingStage).first<{ id: string; review_stage: string; round: number }>() : null;
    if (pendingStage === "internal" && !pendingReview) return apiError("PENDING_REVIEW_REQUIRED", "当前版本没有待处理的内部审核记录，请刷新后重试。", 409);
    const user = await ensureUser(identity); const now = new Date().toISOString();
    const statements = [
      db.prepare("UPDATE content_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = ? AND current_version = ?").bind(toStatus, user.id, now, contentId, organizationId, projectId, fromStatus, item.current_version),
    ];
    if (toStatus === "internal_review") {
      const row = await db.prepare("SELECT COALESCE(MAX(round), 0) + 1 AS next_round FROM content_reviews WHERE content_item_id = ? AND review_stage = 'internal'").bind(contentId).first<{ next_round: number }>();
      statements.push(db.prepare("INSERT INTO content_reviews (id, organization_id, project_id, content_item_id, content_version_id, review_stage, round, decision, note, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, 'internal', ?, 'pending', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, contentId, item.version_id, row?.next_round ?? 1, note || null, user.id, now));
    } else if (fromStatus === "internal_review" && pendingReview) {
      const decision = toStatus === "publish_ready" ? "approved" : "changes_requested";
      statements.push(db.prepare("UPDATE content_reviews SET decision = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decision = 'pending'").bind(decision, note || null, user.id, now, pendingReview.id));
    } else if (fromStatus === "client_review" && pendingReview) {
      const legacyNote = note || "客户审核步骤已停用，记录由内部流程接管。";
      statements.push(db.prepare("UPDATE content_reviews SET decision = 'cancelled', note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decision = 'pending'").bind(legacyNote, user.id, now, pendingReview.id));
    }
    let memoryCandidate: { id: string; status: "candidate" } | null = null;
    if (toStatus === "internal_revision" && pendingReview && note) {
      const reason = note.trim(); const memoryId = crypto.randomUUID(); const memoryContent = reason; const memoryTitle = `审核退回要求 · ${item.title}`.slice(0, 160); const canonicalKey = `review-feedback:${pendingReview.id}`; const contentHash = await sha256Hex(new TextEncoder().encode(memoryContent));
      statements.push(db.prepare("INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, 'review_feedback', ?, 1, ?, ?, ?, ?)").bind(memoryId, organizationId, projectId, canonicalKey, PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND, memoryTitle, memoryContent, JSON.stringify({ contentItemId: contentId, contentTitle: item.title, contentVersionId: item.version_id, contentVersion: item.current_version, reviewId: pendingReview.id, reviewStage: pendingReview.review_stage, reviewRound: pendingReview.round, reason }), pendingReview.id, contentHash, user.id, now, now));
      statements.push(db.prepare("INSERT INTO project_memory_evidence (id, organization_id, project_id, memory_item_id, source_type, source_id, quote, relevance, created_by, created_at) VALUES (?, ?, ?, ?, 'review_feedback', ?, ?, 100, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, memoryId, pendingReview.id, reason, user.id, now));
      memoryCandidate = { id: memoryId, status: "candidate" };
    }
    statements.push(db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'content.status.changed', 'content_item', ?, ?, ?)").bind(crypto.randomUUID(), organizationId, projectId, user.id, contentId, JSON.stringify({ fromStatus, toStatus, version: item.current_version, note: note || null, memoryCandidateId: memoryCandidate?.id || null }), now));
    const results = await db.batch(statements);
    if (!results[0].meta.changes) return apiError("CONTENT_STATE_CHANGED", "内容状态已被其他成员更新，请刷新后重试。", 409);
    return Response.json({ item: { id: contentId, status: toStatus, updated_at: now }, memoryCandidate });
  } catch (error) { return errorResponse(error); }
}
