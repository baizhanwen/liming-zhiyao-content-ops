import { getD1 } from "../db/runtime";
import { assertProjectWriteAccess, projectWriteAccessBindings, projectWriteAccessCondition } from "./project-write-access";
import { assertMemoryAttempt, memoryAttemptBindings, memoryAttemptCondition } from "./project-memory-write";
import { assertAssistantReplyActive, assistantReplyBindings, assistantReplyCondition, type AssistantReplyScope } from "./project-assistant-write";
import { canContinueRewriteWrite, rewriteWriteAccessBindings, rewriteWriteAccessCondition } from "./script-rewrite-write";
import { invokeContentModel, ModelRequestError, type ModelInvocation } from "./model-adapter";
import { readModelUsage, readModelFailureUsage, preserveInterruptedModelUsage } from "./model-usage";

export type ContentModelRequestRecord = {
  id: string; step: string; status: "completed" | "failed";
  latencyMs: number; inputTokens: number | null; outputTokens: number | null;
  totalTokens: number | null; usageKnown: boolean;
};
type RequestContext = {
  id: string; rootCallId: string; organizationId: string; projectId: string;
  topicId: string | null; promptTemplateId: string | null; promptVersion: string;
  taskType?: string;
  modelProfile?: string;
  rewriteWorkspaceId?: string;
  enforceProjectWriteAccess?: boolean;
  assertWriteAccess?: () => Promise<void>;
  memoryEventId?: string;
  memoryAttemptCount?: number;
  assistantReply?: AssistantReplyScope;
  provider: string; model: string; userId: string; step: string;
  inputHash: string; inputJson: string; monthlyLimit: number;
  ledger: ContentModelRequestRecord[];
  contentGeneration?: { contentId: string; version: number; status: string };
};

/** Reserve each provider request atomically, including failed attempts/retries. */
export async function invokeRecordedContentRequest(input: Parameters<typeof invokeContentModel>[0], context: RequestContext, invokeModel: typeof invokeContentModel = invokeContentModel): Promise<ModelInvocation> {
  const db = getD1(), now = new Date().toISOString();
  await context.assertWriteAccess?.();
  const month = now.slice(0, 7) + "-01T00:00:00.000Z";
  const isRoot = context.id === context.rootCallId;
  const rewriteScope = context.rewriteWorkspaceId ? { organizationId: context.organizationId, projectId: context.projectId, userId: context.userId, workspaceId: context.rewriteWorkspaceId } : null;
  const memoryScope = context.memoryEventId && context.memoryAttemptCount !== undefined ? { organizationId: context.organizationId, projectId: context.projectId, eventId: context.memoryEventId, attemptCount: context.memoryAttemptCount } : null;
  const generation = context.contentGeneration;
  const generationSource = `EXISTS(SELECT 1 FROM content_items c WHERE c.id=? AND c.organization_id=? AND c.project_id=?
    AND c.current_version=? AND c.status=? AND c.deleted_at IS NULL)`;
  const generationSourceBindings = generation ? [generation.contentId,context.organizationId,context.projectId,generation.version,generation.status] : [];
  // The existing root record owns the whole generation, including repairs.
  // Its started status ends on success, failure or guarded startup recovery.
  const generationOwner = isRoot
    ? "NOT EXISTS(SELECT 1 FROM model_calls m WHERE m.organization_id=? AND m.project_id=? AND m.topic_id=? AND m.task_type='content_draft' AND m.status='started')"
    : "EXISTS(SELECT 1 FROM model_calls m WHERE m.id=? AND m.organization_id=? AND m.project_id=? AND m.topic_id=? AND m.task_type='content_draft' AND m.status='started')";
  const generationOwnerBindings = isRoot ? [context.organizationId,context.projectId,context.topicId] : [context.rootCallId,context.organizationId,context.projectId,context.topicId];
  const reserved = await db.prepare(`INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM model_calls WHERE organization_id = ? AND created_at >= ?) <
      MIN(?, COALESCE((SELECT monthly_model_call_quota FROM organization_settings WHERE organization_id = ?), ?))
      ${rewriteScope ? `AND ${rewriteWriteAccessCondition}` : ""}
      ${context.enforceProjectWriteAccess ? `AND ${projectWriteAccessCondition}` : ""}
      ${memoryScope ? `AND ${memoryAttemptCondition}` : ""}
      ${context.assistantReply ? `AND ${assistantReplyCondition}` : ""}
      ${generation ? `AND ${generationSource} AND ${generationOwner}` : ""}`)
    .bind(context.id, context.organizationId, context.projectId, context.topicId, context.promptTemplateId,
      isRoot ? (context.taskType ?? "content_draft") : (context.taskType ?? "content_draft") + ".request", context.provider, context.model, context.modelProfile ?? input.profile, context.promptVersion,
      context.inputHash, isRoot ? context.inputJson : JSON.stringify({ ...JSON.parse(context.inputJson), parentModelCallId: context.rootCallId, step: context.step }),
      context.userId, now, context.organizationId, month, context.monthlyLimit, context.organizationId, context.monthlyLimit,
      ...(rewriteScope ? rewriteWriteAccessBindings(rewriteScope) : []),
      ...(context.enforceProjectWriteAccess ? projectWriteAccessBindings(context) : []), ...(memoryScope ? memoryAttemptBindings(memoryScope) : []), ...(context.assistantReply ? assistantReplyBindings(context.assistantReply) : []),
      ...(generation ? [...generationSourceBindings,...generationOwnerBindings] : [])).run();
  if (!reserved.meta.changes) {
    if (context.enforceProjectWriteAccess) await assertProjectWriteAccess(db, context);
    if (memoryScope) await assertMemoryAttempt(db, memoryScope);
    if (context.assistantReply) await assertAssistantReplyActive(db, context.assistantReply);
    if (rewriteScope && !await canContinueRewriteWrite(db, rewriteScope)) throw new ModelRequestError("项目权限或改写工作区状态已改变，本次未发起新的模型请求。", "REWRITE_ACCESS_CHANGED");
    if (generation) {
      if (!await db.prepare(`SELECT 1 WHERE ${generationSource}`).bind(...generationSourceBindings).first()) throw new ModelRequestError("稿件版本或状态已改变，本次未发起新的模型请求。请刷新后核对。", "CONTENT_VERSION_CONFLICT");
      if (!await db.prepare(`SELECT 1 WHERE ${generationOwner}`).bind(...generationOwnerBindings).first()) throw new ModelRequestError(isRoot
        ? "该内容已有生成任务在执行，本次未发起新的模型请求。请等待并刷新运行记录核对；若主机中断，请管理员按启动恢复说明处理。"
        : "该生成任务已因中断或恢复结束，本次未发起后续模型请求。请刷新运行记录核对。",isRoot ? "CONTENT_GENERATION_IN_PROGRESS" : "MODEL_REQUEST_INTERRUPTED");
    }
    throw new ModelRequestError("公司本月模型调用额度已用尽，本次未发起新的模型请求。", "MODEL_QUOTA_EXCEEDED");
  }
  const started = Date.now();
  let response: ModelInvocation;
  try {
    response = await invokeModel(input);
  } catch (error) {
    const record: ContentModelRequestRecord = { id: context.id, step: context.step, status: "failed", latencyMs: Date.now() - started, ...readModelFailureUsage(error) };
    context.ledger.push(record);
    const saved = await db.prepare("UPDATE model_calls SET status = ?, error_code = ?, error_message = ?, output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND status = 'started'")
      .bind(isRoot ? "started" : "failed", error instanceof ModelRequestError ? error.code : "MODEL_REQUEST_FAILED", error instanceof Error ? error.message.slice(0, 1000) : "模型请求失败", JSON.stringify({ usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens }, modelRequests: [record] }), record.latencyMs, isRoot ? null : new Date().toISOString(), context.id).run();
    if (!saved.meta.changes) {
      await preserveInterruptedModelUsage(db,context,record);
      throw new ModelRequestError("该模型请求已因中断或恢复而结束，已停止后续请求，请刷新运行记录核对实际用量。", "MODEL_REQUEST_INTERRUPTED");
    }
    throw error;
  }
  const record: ContentModelRequestRecord = { id: context.id, step: context.step, status: "completed", latencyMs: response.latencyMs, ...readModelUsage(response.raw) };
  context.ledger.push(record);
  // The root's status represents the whole generation. Additional rows each
  // represent one request; the first request uses the existing root row.
  const saved = await db.prepare("UPDATE model_calls SET status = ?, output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND status = 'started'")
    .bind(isRoot ? "started" : "completed", JSON.stringify({ content: response.content.slice(0, 200_000), usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens }, modelRequests: [record] }), response.latencyMs, isRoot ? null : new Date().toISOString(), context.id).run();
  if (!saved.meta.changes) {
    await preserveInterruptedModelUsage(db,context,record);
    throw new ModelRequestError("该模型请求已因中断或恢复而结束，晚到结果仅补记有效用量，不保存稿件。请刷新运行记录后再操作。", "MODEL_REQUEST_INTERRUPTED");
  }
  if (context.enforceProjectWriteAccess) await assertProjectWriteAccess(db, context);
  if (memoryScope) await assertMemoryAttempt(db, memoryScope);
  if (context.assistantReply) await assertAssistantReplyActive(db, context.assistantReply);
  await context.assertWriteAccess?.();
  return response;
}
