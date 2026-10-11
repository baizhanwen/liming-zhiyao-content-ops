export type AssistantReplyScope = { organizationId: string; projectId: string; conversationId: string; messageId: string };
type Database = { prepare(sql: string): { bind(...values: unknown[]): { first(): Promise<unknown> } } };

export class ProjectAssistantChatInterruptedError extends Error {
  readonly code = "PROJECT_ASSISTANT_CHAT_INTERRUPTED";
}
export const assistantReplyCondition = `EXISTS (SELECT 1 FROM project_assistant_messages m
  INNER JOIN project_assistant_conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id AND c.project_id=m.project_id
  WHERE m.id=? AND c.id=? AND m.organization_id=? AND m.project_id=?
    AND m.role='assistant' AND m.status='processing' AND c.status='active')`;
export const assistantReplyBindings = (scope: AssistantReplyScope) => [scope.messageId, scope.conversationId, scope.organizationId, scope.projectId];
export async function assertAssistantReplyActive(db: Database, scope: AssistantReplyScope) {
  if (!await db.prepare(`SELECT 1 WHERE ${assistantReplyCondition}`).bind(...assistantReplyBindings(scope)).first()) {
    throw new ProjectAssistantChatInterruptedError("会话已归档或回复状态已改变，已停止后续模型请求和结果保存；此前发出的请求仍计入用量。请刷新后再操作。");
  }
}
