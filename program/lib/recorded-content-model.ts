import { getD1 } from "../db/runtime";
import { invokeContentModel, ModelRequestError, type ModelInvocation } from "./model-adapter";

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
  provider: string; model: string; userId: string; step: string;
  inputHash: string; inputJson: string; monthlyLimit: number;
  ledger: ContentModelRequestRecord[];
};

function readUsage(raw: unknown) {
  const usage = raw && typeof raw === "object" ? (raw as { usage?: Record<string, unknown> }).usage : undefined;
  const number = (name: string) => typeof usage?.[name] === "number" && Number.isSafeInteger(usage[name]) && usage[name] >= 0 ? usage[name] as number : null;
  const inputTokens = number("prompt_tokens") ?? number("input_tokens"), outputTokens = number("completion_tokens") ?? number("output_tokens"), totalTokens = number("total_tokens");
  return { inputTokens, outputTokens, totalTokens, usageKnown: totalTokens !== null || (inputTokens !== null && outputTokens !== null) };
}

/** Reserve each provider request atomically, including failed attempts/retries. */
export async function invokeRecordedContentRequest(input: Parameters<typeof invokeContentModel>[0], context: RequestContext, invokeModel: typeof invokeContentModel = invokeContentModel): Promise<ModelInvocation> {
  const db = getD1(), now = new Date().toISOString();
  const month = now.slice(0, 7) + "-01T00:00:00.000Z";
  const isRoot = context.id === context.rootCallId;
  const reserved = await db.prepare(`INSERT INTO model_calls (id, organization_id, project_id, topic_id, prompt_template_id, task_type, provider, model_name, model_profile, prompt_version, status, input_hash, input_json, created_by, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM model_calls WHERE organization_id = ? AND created_at >= ?) <
      MIN(?, COALESCE((SELECT monthly_model_call_quota FROM organization_settings WHERE organization_id = ?), ?))`)
    .bind(context.id, context.organizationId, context.projectId, context.topicId, context.promptTemplateId,
      isRoot ? (context.taskType ?? "content_draft") : (context.taskType ?? "content_draft") + ".request", context.provider, context.model, context.modelProfile ?? input.profile, context.promptVersion,
      context.inputHash, isRoot ? context.inputJson : JSON.stringify({ ...JSON.parse(context.inputJson), parentModelCallId: context.rootCallId, step: context.step }),
      context.userId, now, context.organizationId, month, context.monthlyLimit, context.organizationId, context.monthlyLimit).run();
  if (!reserved.meta.changes) throw new ModelRequestError("公司本月模型调用额度已用尽，本次未发起新的模型请求。", "MODEL_QUOTA_EXCEEDED");
  const started = Date.now();
  let response: ModelInvocation;
  try {
    response = await invokeModel(input);
  } catch (error) {
    const record: ContentModelRequestRecord = { id: context.id, step: context.step, status: "failed", latencyMs: Date.now() - started, ...readUsage(null) };
    context.ledger.push(record);
    await db.prepare("UPDATE model_calls SET status = ?, error_code = ?, error_message = ?, output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND status = 'started'")
      .bind(isRoot ? "started" : "failed", error instanceof ModelRequestError ? error.code : "MODEL_REQUEST_FAILED", error instanceof Error ? error.message.slice(0, 1000) : "模型请求失败", JSON.stringify({ usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens }, modelRequests: [record] }), record.latencyMs, isRoot ? null : new Date().toISOString(), context.id).run();
    throw error;
  }
  const record: ContentModelRequestRecord = { id: context.id, step: context.step, status: "completed", latencyMs: response.latencyMs, ...readUsage(response.raw) };
  context.ledger.push(record);
  // The root's status represents the whole generation. Additional rows each
  // represent one request; the first request uses the existing root row.
  await db.prepare("UPDATE model_calls SET status = ?, output_json = ?, latency_ms = ?, completed_at = ? WHERE id = ? AND status = 'started'")
    .bind(isRoot ? "started" : "completed", JSON.stringify({ content: response.content.slice(0, 200_000), usage: { inputTokens: record.inputTokens, outputTokens: record.outputTokens, totalTokens: record.totalTokens }, modelRequests: [record] }), response.latencyMs, isRoot ? null : new Date().toISOString(), context.id).run();
  return response;
}
