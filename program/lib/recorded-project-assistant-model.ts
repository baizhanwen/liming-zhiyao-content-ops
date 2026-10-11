import { getD1, sha256Hex } from "../db/runtime";
import { checkOrganizationQuota } from "./operations";
import { invokeRecordedContentRequest, type ContentModelRequestRecord } from "./recorded-content-model";
import { invokeProjectAssistantModel, readProjectAssistantModelConfig, ProjectAssistantRequestError } from "./project-assistant-model";

type Scope = {
  organizationId: string; projectId: string; userId: string;
  taskType: "project_assistant.chat" | "project_assistant.memory" | "project_assistant.probe";
  promptVersion: string; sourceId?: string;
};

/** Record each independent assistant request, including optional repairs and probes. */
export function createRecordedProjectAssistantInvoker(scope: Scope) {
  return async (input: Parameters<typeof invokeProjectAssistantModel>[0]) => {
    const config = readProjectAssistantModelConfig();
    const quota = await checkOrganizationQuota(scope.organizationId, scope.userId, "modelCalls");
    if (!quota.allowed) throw new ProjectAssistantRequestError("公司本月模型调用额度已用尽，独立项目助理未发起新的请求。", "MODEL_QUOTA_EXCEEDED");
    const id = crypto.randomUUID(), ledger: ContentModelRequestRecord[] = [], db = getD1();
    const inputHash = await sha256Hex(new TextEncoder().encode(input.system + "\n" + input.user));
    try {
      const response = await invokeRecordedContentRequest({ ...input, profile: "max" }, {
        id, rootCallId: id, organizationId: scope.organizationId, projectId: scope.projectId, userId: scope.userId,
        topicId: null, promptTemplateId: null, taskType: scope.taskType, modelProfile: "project_assistant",
        promptVersion: scope.promptVersion, provider: config.provider, model: config.model,
        inputHash, inputJson: JSON.stringify({ sourceId: scope.sourceId ?? null }), step: scope.taskType,
        monthlyLimit: quota.limit, ledger,
      }, async () => ({ ...await invokeProjectAssistantModel(input), profile: "max" as const }));
      const recorded = await db.prepare("UPDATE model_calls SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'started'")
        .bind(new Date().toISOString(), id).run();
      if (!recorded.meta.changes) throw new ProjectAssistantRequestError("独立项目助理的请求记录已改变，结果没有继续写入。", "PROJECT_ASSISTANT_RECORD_CHANGED");
      return response;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "PROJECT_ASSISTANT_REQUEST_FAILED";
      const message = error instanceof Error ? error.message : "独立项目助理请求失败。";
      if (ledger.length) await db.prepare("UPDATE model_calls SET status = 'failed', error_code = ?, error_message = ?, output_json = ?, completed_at = ? WHERE id = ? AND status = 'started'")
        .bind(code, message.slice(0, 1000), JSON.stringify({ modelRequests: ledger }), new Date().toISOString(), id).run();
      throw new ProjectAssistantRequestError(message, code);
    }
  };
}
