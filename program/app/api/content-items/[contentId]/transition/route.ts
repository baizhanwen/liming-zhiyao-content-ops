import { ensureUser, getD1, getProjectAccess, sha256Hex } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { allowedWorkflowTransition, contentStatuses, workflowTransitionSchema, type ContentStatus } from "../../../../../lib/content-workflow";
import { PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND } from "../../../../../lib/project-memory-taxonomy";
import { readRequestIdentity } from "../../../../../lib/request-auth";

import { commitContentWorkflowWrite, nextWriteTimestamp } from "../../../../../lib/content-workflow-write";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ contentId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新内容状态。", 401);
  try {
    const parsed = workflowTransitionSchema.safeParse(await request.json());
    if (!parsed.success) return apiError("INVALID_WORKFLOW_TRANSITION", parsed.error.issues[0]?.message || "状态流转参数无效。", 400);
    const { organizationId, projectId, toStatus, note, expectedVersion } = parsed.data;
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该项目。", 403);
    const { contentId } = await context.params; const db = getD1();
    const item = await db.prepare(`
      SELECT c.id, c.title, c.status, c.current_version,c.updated_at, v.id AS version_id, v.generation_mode
      FROM content_items c INNER JOIN content_versions v ON v.content_item_id = c.id AND v.version = c.current_version AND v.organization_id = c.organization_id AND v.project_id = c.project_id
      WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ? AND c.deleted_at IS NULL
    `).bind(contentId, organizationId, projectId).first<{ id: string; title: string; status: string; current_version: number; updated_at:string; version_id: string; generation_mode: string }>();
    if (!item || !contentStatuses.includes(item.status as ContentStatus)) return apiError("CONTENT_NOT_FOUND", "内容不存在或状态无效。", 404);
    if (expectedVersion !== undefined && expectedVersion !== item.current_version) return apiError("CONTENT_VERSION_CONFLICT", "稿件已更新，请刷新并核对当前版本后再操作。", 409);
    const fromStatus = item.status as ContentStatus;
    if (!allowedWorkflowTransition(access, fromStatus, toStatus)) return apiError("WORKFLOW_TRANSITION_DENIED", "当前角色不能执行这次状态流转。", 403);
    if (toStatus === "internal_review" && item.generation_mode === "scaffold") return apiError("CONTENT_SCRIPT_REQUIRED", "这份内容尚未生成口播稿，请完成生成或手动写稿并保存后再提交审核。", 409);
    const pendingStage = fromStatus === "internal_review" ? "internal" : fromStatus === "client_review" ? "client" : null;
    const pendingReview = pendingStage ? await db.prepare("SELECT id, review_stage, round FROM content_reviews WHERE organization_id = ? AND project_id = ? AND content_item_id = ? AND content_version_id = ? AND review_stage = ? AND decision = 'pending' ORDER BY round DESC LIMIT 1").bind(organizationId, projectId, contentId, item.version_id, pendingStage).first<{ id: string; review_stage: string; round: number }>() : null;
    if (pendingStage === "internal" && !pendingReview) return apiError("PENDING_REVIEW_REQUIRED", "当前版本没有待处理的内部审核记录，请刷新后重试。", 409);
    if (toStatus === "published" && !await db.prepare("SELECT id FROM content_reviews WHERE content_version_id = ? AND organization_id = ? AND project_id = ? AND review_stage = 'internal' AND decision = 'approved'").bind(item.version_id, organizationId, projectId).first()) return apiError("CURRENT_VERSION_APPROVAL_REQUIRED", "当前版本尚未通过内部审核，请先重新提交审核。", 409);
    const user=await ensureUser(identity),now=nextWriteTimestamp(item.updated_at);
    const reviewRound=toStatus==="internal_review"?(await db.prepare("SELECT COALESCE(MAX(round),0)+1 AS next_round FROM content_reviews WHERE content_item_id=? AND review_stage='internal'").bind(contentId).first<{next_round:number}>())?.next_round??1:null;
    const feedback=toStatus==="internal_revision"&&pendingReview&&note?{id:crypto.randomUUID(),reason:note.trim(),hash:await sha256Hex(new TextEncoder().encode(note.trim()))}:null;
    const memoryCandidate: {id:string;status:"candidate"}|null=feedback?{id:feedback.id,status:"candidate"}:null;
    const mutate=(operationSql:string,auditId:string)=>{

      const statements = [
        db.prepare(`UPDATE content_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = ? AND current_version = ? AND ${operationSql}`).bind(toStatus, user.id, now, contentId, organizationId, projectId, fromStatus, item.current_version, auditId),
      ];
      if (toStatus === "internal_review") {

        statements.push(db.prepare(`INSERT INTO content_reviews (id, organization_id, project_id, content_item_id, content_version_id, review_stage, round, decision, note, requested_by, requested_at) SELECT ?, ?, ?, ?, ?, 'internal', ?, 'pending', ?, ?, ? WHERE ${operationSql}`).bind(crypto.randomUUID(), organizationId, projectId, contentId, item.version_id, reviewRound, note || null, user.id, now, auditId));
      } else if (fromStatus === "internal_review" && pendingReview) {
        const decision = toStatus === "publish_ready" ? "approved" : "changes_requested";
        statements.push(db.prepare(`UPDATE content_reviews SET decision = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decision = 'pending' AND ${operationSql}`).bind(decision, note || null, user.id, now, pendingReview.id, auditId));
      } else if (fromStatus === "client_review" && pendingReview) {
        const legacyNote = note || "客户审核步骤已停用，记录由内部流程接管。";
        statements.push(db.prepare(`UPDATE content_reviews SET decision = 'cancelled', note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND decision = 'pending' AND ${operationSql}`).bind(legacyNote, user.id, now, pendingReview.id, auditId));
      }
      if (fromStatus === "client_review" && toStatus === "publish_ready") statements.push(db.prepare(`INSERT INTO content_reviews (id, organization_id, project_id, content_item_id, content_version_id, review_stage, round, decision, note, requested_by, requested_at, decided_by, decided_at)
        SELECT ?, ?, ?, ?, ?, 'internal', (SELECT COALESCE(MAX(round), 0) + 1 FROM content_reviews WHERE content_item_id = ? AND review_stage = 'internal'), 'approved', ?, ?, ?, ?, ? WHERE ${operationSql}`)
        .bind(crypto.randomUUID(), organizationId, projectId, contentId, item.version_id, contentId, note || "旧客户审核流程由内部审核接管。", user.id, now, user.id, now, auditId));

      if (feedback && pendingReview) {
        const reason=feedback.reason,memoryId=feedback.id,memoryContent=reason,memoryTitle=`审核退回要求 · ${item.title}`.slice(0,160),canonicalKey=`review-feedback:${pendingReview.id}`,contentHash=feedback.hash;
        statements.push(db.prepare(`INSERT INTO project_memory_items (id, organization_id, project_id, canonical_key, category, kind, status, title, content, value_json, source_type, source_id, revision, content_hash, created_by, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, 'review_feedback', ?, 1, ?, ?, ?, ? WHERE ${operationSql}`).bind(memoryId, organizationId, projectId, canonicalKey, PROJECT_MEMORY_STORAGE_CATEGORY, PROJECT_MEMORY_STORAGE_KIND, memoryTitle, memoryContent, JSON.stringify({ contentItemId: contentId, contentTitle: item.title, contentVersionId: item.version_id, contentVersion: item.current_version, reviewId: pendingReview.id, reviewStage: pendingReview.review_stage, reviewRound: pendingReview.round, reason }), pendingReview.id, contentHash, user.id, now, now, auditId));
        statements.push(db.prepare(`INSERT INTO project_memory_evidence (id, organization_id, project_id, memory_item_id, source_type, source_id, quote, relevance, created_by, created_at) SELECT ?, ?, ?, ?, 'review_feedback', ?, ?, 100, ?, ? WHERE ${operationSql}`).bind(crypto.randomUUID(), organizationId, projectId, memoryId, pendingReview.id, reason, user.id, now, auditId));

      }
      return statements;
    };
    const committed=await commitContentWorkflowWrite(db,{
      request,authSubject:identity.authSubject,scope:{organizationId,projectId,userId:user.id},targetId:contentId,version:now,
      action:"content.status.changed",targetType:"content_item",metadata:{fromStatus,toStatus,version:item.current_version,note:note||null,memoryCandidateId:memoryCandidate?.id||null},
      guard:`EXISTS(SELECT 1 FROM content_items c JOIN content_versions v ON v.content_item_id=c.id AND v.version=c.current_version AND v.organization_id=c.organization_id AND v.project_id=c.project_id
        WHERE c.id=? AND c.organization_id=? AND c.project_id=? AND c.status=? AND c.current_version=? AND c.updated_at=? AND v.id=? AND c.deleted_at IS NULL)
        ${pendingReview?"AND EXISTS(SELECT 1 FROM content_reviews WHERE id=? AND organization_id=? AND project_id=? AND content_item_id=? AND content_version_id=? AND decision='pending')":""}
        ${toStatus==="published"?"AND EXISTS(SELECT 1 FROM content_reviews WHERE content_version_id=? AND organization_id=? AND project_id=? AND review_stage='internal' AND decision='approved')":""}
        ${reviewRound!==null?"AND (SELECT COALESCE(MAX(round),0)+1 FROM content_reviews WHERE content_item_id=? AND review_stage='internal')=?":""}`,
      bindings:[contentId,organizationId,projectId,fromStatus,item.current_version,item.updated_at,item.version_id,
        ...(pendingReview?[pendingReview.id,organizationId,projectId,contentId,item.version_id]:[]),
        ...(toStatus==="published"?[item.version_id,organizationId,projectId]:[]),...(reviewRound!==null?[contentId,reviewRound]:[])],mutate,
    });
    if(!committed)return apiError("CONTENT_STATE_CHANGED","稿件、审核或状态已被其他操作更新，本次未保存，请刷新核对后再操作。",409);
    return Response.json({ item: { id: contentId, status: toStatus, updated_at: now }, memoryCandidate });
  } catch (error) { return errorResponse(error); }
}
