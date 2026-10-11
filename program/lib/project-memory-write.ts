export type MemoryAttemptScope = { eventId: string; organizationId: string; projectId: string; attemptCount: number };
type Database = { prepare(sql: string): { bind(...values: unknown[]): { first(): Promise<unknown> } } };

export class ProjectMemoryAttemptChangedError extends Error {
  readonly code = "PROJECT_MEMORY_ATTEMPT_CHANGED";
  constructor() { super("该记忆提取轮次已结束或被重新认领，晚到结果没有写入。请刷新事件状态后再操作。"); }
}
export const memoryAttemptCondition = "EXISTS (SELECT 1 FROM project_memory_events WHERE id=? AND organization_id=? AND project_id=? AND status='processing' AND attempt_count=?)";
export const memoryAttemptBindings = (scope: MemoryAttemptScope) => [scope.eventId, scope.organizationId, scope.projectId, scope.attemptCount];
export async function assertMemoryAttempt(db: Database, scope: MemoryAttemptScope) {
  if (!await db.prepare(`SELECT 1 WHERE ${memoryAttemptCondition}`).bind(...memoryAttemptBindings(scope)).first()) throw new ProjectMemoryAttemptChangedError();
}
