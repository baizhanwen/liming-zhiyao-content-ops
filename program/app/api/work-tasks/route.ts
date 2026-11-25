import { getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { findWorkTask, readWorkTaskBoard, workTaskPriorities, workTaskTypes } from "../../../lib/work-tasks";

const cleanText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问工作任务。", 401);
  const organizationId = cleanText(new URL(request.url).searchParams.get("organizationId"), 100);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作任务。", 403);
    return Response.json(await readWorkTaskBoard(organizationId, access.userId, access.organizationRole === "admin"));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再布置工作任务。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = cleanText(payload.organizationId, 100);
    const projectId = cleanText(payload.projectId, 100) || null;
    const assigneeUserId = cleanText(payload.assigneeUserId, 100);
    const taskType = cleanText(payload.taskType, 40);
    const title = cleanText(payload.title, 160);
    const description = cleanText(payload.description, 1000) || null;
    const requirements = cleanText(payload.deliveryRequirements, 1000) || null;
    const priority = cleanText(payload.priority, 20) || "normal";
    const targetCount = Number(payload.targetCount ?? 1);
    const due = new Date(cleanText(payload.dueAt, 50));
    const requestId = payload.requestId ?? request.headers.get("Idempotency-Key");
    if (requestId != null && (typeof requestId !== "string" || !/^[\w.-]{1,128}$/.test(requestId))) return apiError("REQUEST_ID_INVALID", "任务提交标识无效。", 400);
    if (!organizationId || !assigneeUserId || !workTaskTypes.includes(taskType as never)) return apiError("TASK_SCOPE_REQUIRED", "请选择员工和有效的任务类型。", 400);
    if (!title) return apiError("TASK_TITLE_REQUIRED", "请填写具体的任务标题。", 400);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) return apiError("TASK_TARGET_INVALID", "任务数量必须是 1 到 100 的整数。", 400);
    if (!workTaskPriorities.includes(priority as never)) return apiError("TASK_PRIORITY_INVALID", "请选择有效的优先级。", 400);
    if (!Number.isFinite(due.getTime())) return apiError("TASK_DUE_INVALID", "请填写有效的截止时间。", 400);
    const dueAt = due.toISOString();
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以给员工布置任务。", 403);

    const db = getD1();
    async function replay() {
      if (!requestId || !access) return null;
      const existing = await db.prepare("SELECT id FROM work_tasks WHERE organization_id = ? AND created_by = ? AND request_id = ?")
        .bind(organizationId, access.userId, requestId).first<{ id: string }>();
      if (!existing) return null;
      const task = await findWorkTask(organizationId, access.userId, true, existing.id);
      if (task && task.title === title && task.description === description && task.delivery_requirements === requirements && task.priority === priority
        && task.assignee_user_id === assigneeUserId && task.project_id === projectId && task.task_type === taskType && task.target_count === targetCount && task.due_at === dueAt)
        return Response.json({ workTask: task });
      return apiError("TASK_REQUEST_CONFLICT", "这次提交已关联其他任务内容，请重新发起。", 409);
    }
    const existing = await replay();
    if (existing) return existing;
    if (due.getTime() <= Date.now()) return apiError("TASK_DUE_INVALID", "截止时间必须晚于当前时间。", 400);
    const [assignee, project] = await Promise.all([
      db.prepare(`SELECT 1 AS allowed FROM organization_members member JOIN users u ON u.id = member.user_id
        WHERE member.organization_id = ? AND member.user_id = ? AND member.role = 'member' AND member.status = 'active' AND u.status = 'active'`)
        .bind(organizationId, assigneeUserId).first(),
      projectId ? db.prepare(`SELECT EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.organization_id=p.organization_id
        AND m.user_id=? AND m.status='active') AS allowed FROM projects p WHERE p.organization_id=? AND p.id=? AND p.deleted_at IS NULL AND p.status!='archived'`)
        .bind(assigneeUserId, organizationId, projectId).first<{ allowed: number }>() : Promise.resolve(null),
    ]);
    if (!assignee) return apiError("TASK_ASSIGNEE_INVALID", "只能给当前公司的有效员工布置任务。", 409);
    if (projectId && !project) return apiError("PROJECT_NOT_FOUND", "企业空间不存在或已经归档。", 404);
    if (project && !project.allowed) return apiError("TASK_PROJECT_ACCESS_REQUIRED", "该员工尚未加入这个企业空间。", 409);

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const result = await db.batch([
      db.prepare(`INSERT INTO work_tasks
        (id, organization_id, project_id, assignee_user_id, task_type, title, description, delivery_requirements, target_count,
         priority, progress_mode, starts_at, due_at, created_by, updated_by, created_at, updated_at, request_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,'manual',?,?,?,?,?,?,? WHERE EXISTS (
          SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.organization_id=? AND m.user_id=? AND m.role='admin' AND m.status='active' AND u.status='active')
        AND EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
          WHERE m.organization_id=? AND m.user_id=? AND m.role='member' AND m.status='active' AND u.status='active')
        AND (? IS NULL OR EXISTS (SELECT 1 FROM projects p JOIN project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
          WHERE p.id=? AND p.organization_id=? AND p.status!='archived' AND p.deleted_at IS NULL AND m.user_id=? AND m.status='active'))
        ON CONFLICT(organization_id, created_by, request_id) DO NOTHING`)
        .bind(id, organizationId, projectId, assigneeUserId, taskType, title, description, requirements, targetCount, priority, now, dueAt, access.userId, access.userId, now, now, requestId,
          organizationId, access.userId, organizationId, assigneeUserId, projectId, projectId, organizationId, assigneeUserId),
      db.prepare(`INSERT INTO work_task_updates (id, task_id, actor_user_id, action, status, created_at)
        SELECT ?,id,created_by,'created','pending',created_at FROM work_tasks WHERE id=?`).bind(crypto.randomUUID(), id),
      db.prepare(`INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
        SELECT ?,organization_id,project_id,created_by,'work_task.created','work_task',id,?,created_at FROM work_tasks WHERE id=?`)
        .bind(crypto.randomUUID(), JSON.stringify({ assigneeUserId, taskType, targetCount, dueAt }), id),
    ]);
    if (!result[0].meta.changes) return await replay() ?? apiError("TASK_SCOPE_CHANGED", "成员或空间权限已更新，请刷新后再派发。", 409);
    return Response.json({ workTask: await findWorkTask(organizationId, access.userId, true, id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
