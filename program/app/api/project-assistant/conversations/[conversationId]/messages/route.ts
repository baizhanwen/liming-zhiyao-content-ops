import { canWriteProjectAccess, ensureUser, getD1, getProjectAccess } from "../../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../../lib/api-response";
import { ProjectAssistantInvalidResponseError } from "../../../../../../lib/project-assistant-contract";
import { runProjectAssistantConversationWithDb } from "../../../../../../lib/project-assistant-conversation";
import {
  invokeProjectAssistantModel,
  ProjectAssistantConfigurationError,
  ProjectAssistantRequestError,
} from "../../../../../../lib/project-assistant-model";
import type { ProjectAssistantDatabase } from "../../../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再与项目助理对话。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = text(payload.organizationId, 100);
    const projectId = text(payload.projectId, 100);
    const question = text(payload.question, 12_000);
    const { conversationId } = await context.params;
    if (!organizationId || !projectId || !conversationId) return apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或会话范围。", 400);
    if (question.length < 2) return apiError("QUESTION_REQUIRED", "请输入至少 2 个字符的问题。", 400);
    const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
    if (!access || !canWriteProjectAccess(access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能发送灵感对话。", 403);
    const user = await ensureUser(identity);
    const result = await runProjectAssistantConversationWithDb(
      getD1() as unknown as ProjectAssistantDatabase,
      {
        organizationId,
        projectId,
        conversationId,
        userId: user.id,
        question,
        invoke: invokeProjectAssistantModel,
      },
    );
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectAssistantConfigurationError) return apiError(error.code, error.message, 503);
    if (error instanceof ProjectAssistantRequestError) return apiError(error.code, error.message, 502);
    if (error instanceof ProjectAssistantInvalidResponseError) return apiError(error.code, error.message, 502);
    if (error instanceof Error && error.message.includes("不存在")) return apiError("CONVERSATION_NOT_FOUND", error.message, 404);
    return errorResponse(error);
  }
}
