import { ensureUser, getD1, getOrganizationAccess } from "../../../db/runtime";
import { apiError, errorResponse } from "../../../lib/api-response";
import { readRequestIdentity } from "../../../lib/request-auth";
import { listWorkTasks, workTaskPriorities, workTaskTypes } from "../../../lib/work-tasks";

const cleanText = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const taskLabels: Record<string, string> = {
  video_analysis: "视频分析",
  topic: "选题",
  content: "内容",
  review: "内容审核",
  publish: "作品发布",
  custom: "自定义任务",
};

export async function GET(request: Request) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再访问工作任务。", 401);
  const organizationId = cleanText(new URL(request.url).searchParams.get("organizationId"), 100);
  if (!organizationId) return apiError("ORGANIZATION_REQUIRED", "缺少公司范围。", 400);
  try {
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作任务。", 403);
    const tasks = await listWorkTasks(organizationId, access.userId, access.organizationRole === "admin");
    return Response.json({ workTasks: tasks, canAssign: access.organizationRole === "admin" });
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
    const projectId = cleanText(payload.projectId, 100);
    const assigneeUserId = cleanText(payload.assigneeUserId, 100);
    const taskType = cleanText(payload.taskType, 40);
    const titleInput = cleanText(payload.title, 160);
    const description = cleanText(payload.description, 1_000);
    const priorityInput = cleanText(payload.priority, 20);
    const targetCount = Math.trunc(Number(payload.targetCount));
    const dueAtDate = new Date(cleanText(payload.dueAt, 50));
    if (!organizationId || !assigneeUserId || !workTaskTypes.includes(taskType as never)) return apiError("TASK_SCOPE_REQUIRED", "请选择员工和有效的任务类型。", 400);
    if (taskType !== "custom" && !projectId) return apiError("TASK_PROJECT_REQUIRED", "自动统计任务必须选择企业空间。", 400);
    if (!Number.isFinite(targetCount) || targetCount < 1 || targetCount > 100) return apiError("TASK_TARGET_INVALID", "任务数量必须是 1 到 100。", 400);
    if (Number.isNaN(dueAtDate.getTime()) || dueAtDate.getTime() <= Date.now()) return apiError("TASK_DUE_INVALID", "截止时间必须晚于当前时间。", 400);
    const access = await getOrganizationAccess(identity.authSubject, organizationId);
    if (!access || access.organizationRole !== "admin") return apiError("ADMIN_REQUIRED", "只有公司管理员可以给员工布置任务。", 403);

    const db = getD1();
    const [assignee, project] = await Promise.all([
      db.prepare(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name
        FROM organization_members member INNER JOIN users u ON u.id = member.user_id
        WHERE member.organization_id = ? AND member.user_id = ? AND member.role = 'member' AND member.status = 'active' LIMIT 1`)
        .bind(organizationId, assigneeUserId).first<{ id: string; name: string }>(),
      projectId
        ? db.prepare("SELECT id, name FROM projects WHERE organization_id = ? AND id = ? AND deleted_at IS NULL AND status != 'archived' LIMIT 1").bind(organizationId, projectId).first<{ id: string; name: string }>()
        : Promise.resolve(null),
    ]);
    if (!assignee) return apiError("TASK_ASSIGNEE_INVALID", "只能给当前公司的有效员工布置任务。", 409);
    if (projectId && !project) return apiError("PROJECT_NOT_FOUND", "企业空间不存在或已经归档。", 404);
    if (projectId) {
      const membership = await db.prepare("SELECT 1 AS allowed FROM project_members WHERE organization_id = ? AND project_id = ? AND user_id = ? AND status = 'active' LIMIT 1").bind(organizationId, projectId, assigneeUserId).first<{ allowed: number }>();
      if (!membership) return apiError("TASK_PROJECT_ACCESS_REQUIRED", "该员工尚未加入这个企业空间，请先分配企业空间权限。", 409);
    }
    const duplicate = (await listWorkTasks(organizationId, access.userId, true, 100)).find((task) =>
      task.assignee_user_id === assigneeUserId
      && task.task_type === taskType
      && task.project_id === (projectId || null)
      && !["completed", "cancelled"].includes(task.status)
    );
    if (duplicate) return apiError("ACTIVE_TASK_ALREADY_EXISTS", "该员工在这个企业空间已有同类型未完成任务，请完成或取消后再布置。", 409);

    const actor = await ensureUser(identity);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const priority = workTaskPriorities.includes(priorityInput as never) ? priorityInput : "normal";
    const title = titleInput || `完成 ${targetCount} 个${taskLabels[taskType]}`;
    await db.batch([
      db.prepare(`INSERT INTO work_tasks
        (id, organization_id, project_id, assignee_user_id, task_type, title, description, target_count, completed_count, priority, status, starts_at, due_at, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .bind(id, organizationId, projectId || null, assigneeUserId, taskType, title, description || null, targetCount, priority, now, dueAtDate.toISOString(), actor.id, actor.id, now, now),
      db.prepare("INSERT INTO audit_logs (id, organization_id, project_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, 'work_task.created', 'work_task', ?, ?, ?)")
        .bind(crypto.randomUUID(), organizationId, projectId || null, actor.id, id, JSON.stringify({ assigneeUserId, taskType, targetCount, dueAt: dueAtDate.toISOString() }), now),
    ]);
    const task = (await listWorkTasks(organizationId, access.userId, true)).find((item) => item.id === id);
    return Response.json({ workTask: task }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
