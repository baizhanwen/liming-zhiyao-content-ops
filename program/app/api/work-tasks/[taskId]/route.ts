import { ensureUser, getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { listWorkTasks } from "../../../../lib/work-tasks";

const cleanText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function PATCH(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新工作任务。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = cleanText(payload.organizationId, 100);
    const action = cleanText(payload.action, 30);
    const { taskId } = await context.params;
    if (!organizationId || !taskId) return apiError("TASK_SCOPE_REQUIRED", "缺少工作任务范围。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权更新该公司的工作任务。", 403);
    const db = getD1();
    const task = await db.prepare("SELECT id, assignee_user_id, task_type, target_count, completed_count, status, project_id FROM work_tasks WHERE id = ? AND organization_id = ? LIMIT 1")
      .bind(taskId, organizationId).first<{ id: string; assignee_user_id: string; task_type: string; target_count: number; completed_count: number; status: string; project_id: string | null }>();
    if (!task) return apiError("TASK_NOT_FOUND", "没有找到这条工作任务。", 404);
    const isAdmin = access.organizationRole === "admin";
    if (!isAdmin && task.assignee_user_id !== access.userId) return apiError("TASK_ACCESS_DENIED", "只能更新分配给自己的任务。", 403);
    const actor = await ensureUser(identity);
    const now = new Date().toISOString();

    if (action === "cancel") {
      if (!isAdmin) return apiError("ADMIN_REQUIRED", "只有公司管理员可以取消任务。", 403);
      await db.prepare("UPDATE work_tasks SET status = 'cancelled', updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status != 'cancelled'")
        .bind(actor.id, now, taskId, organizationId).run();
    } else {
      if (task.task_type !== "custom") return apiError("AUTOMATIC_TASK_PROGRESS", "这类任务由实际业务记录自动更新进度，不能手动修改。", 409);
      const completedCount = action === "complete"
        ? Number(task.target_count)
        : action === "reopen"
          ? 0
          : Math.trunc(Number(payload.completedCount));
      if (!Number.isFinite(completedCount) || completedCount < 0 || completedCount > Number(task.target_count)) return apiError("TASK_PROGRESS_INVALID", "任务进度超出有效范围。", 400);
      const status = completedCount >= Number(task.target_count) ? "completed" : completedCount > 0 ? "in_progress" : "pending";
      await db.prepare("UPDATE work_tasks SET completed_count = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status != 'cancelled'")
        .bind(completedCount, status, actor.id, now, taskId, organizationId).run();
    }

    await db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, 'work_task', ?, ?, ?)")
      .bind(crypto.randomUUID(), organizationId, task.project_id, actor.id, action === "cancel" ? "work_task.cancelled" : "work_task.progress_updated", taskId, JSON.stringify({ action, completedCount: payload.completedCount ?? null }), now).run();
    const updated = (await listWorkTasks(organizationId, access.userId, isAdmin)).find((item) => item.id === taskId);
    return Response.json({ workTask: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
