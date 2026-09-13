import { canWriteProjectAccess, getD1, getProjectAccess } from "../../../../../db/runtime";
import { apiError, errorResponse } from "../../../../../lib/api-response";
import { readProjectAssistantMessagesWithDb } from "../../../../../lib/project-assistant-conversation";
import type { ProjectAssistantDatabase } from "../../../../../lib/project-memory-events";
import { readRequestIdentity } from "../../../../../lib/request-auth";

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

async function scope(request: Request, conversationId: string) {
  const identity = await readRequestIdentity(request);
  if (!identity) return { error: apiError("AUTH_REQUIRED", "请先登录后再访问灵感对话。", 401) } as const;
  const url = new URL(request.url);
  const organizationId = text(url.searchParams.get("organizationId"), 100);
  const projectId = text(url.searchParams.get("projectId"), 100);
  if (!organizationId || !projectId || !conversationId) return { error: apiError("PROJECT_SCOPE_REQUIRED", "缺少公司、项目或会话范围。", 400) } as const;
  const access = await getProjectAccess(identity.authSubject, organizationId, projectId);
  if (!access) return { error: apiError("ACCESS_DENIED", "无权访问该项目的灵感对话。", 403) } as const;
  return { organizationId, projectId, conversationId, access } as const;
}

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  const current = await scope(request, conversationId);
  if ("error" in current) return current.error;
  try {
    const result = await readProjectAssistantMessagesWithDb(
      getD1() as unknown as ProjectAssistantDatabase,
      current,
    );
    if (!result) return apiError("CONVERSATION_NOT_FOUND", "灵感对话不存在。", 404);
    return Response.json({ ...result, canWrite: canWriteProjectAccess(current.access) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  const current = await scope(request, conversationId);
  if ("error" in current) return current.error;
  if (!canWriteProjectAccess(current.access)) return apiError("WRITE_ACCESS_REQUIRED", "当前角色不能归档灵感对话。", 403);
  try {
    const now = new Date().toISOString();
    const result = await getD1().prepare(
      "UPDATE project_assistant_conversations SET status = 'archived', updated_at = ? WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'",
    ).bind(now, conversationId, current.organizationId, current.projectId).run();
    if (!result.meta.changes) return apiError("CONVERSATION_NOT_FOUND", "灵感对话不存在或已经归档。", 404);
    return Response.json({ id: conversationId, status: "archived" });
  } catch (error) {
    return errorResponse(error);
  }
}
