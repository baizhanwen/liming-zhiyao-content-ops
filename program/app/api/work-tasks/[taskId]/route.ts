import { getD1, getOrganizationAccess } from "../../../../db/runtime";
import { apiError, errorResponse } from "../../../../lib/api-response";
import { readRequestIdentity } from "../../../../lib/request-auth";
import { findWorkTask, listWorkTaskUpdates, type WorkTask, type WorkTaskAction, type WorkTaskStatus } from "../../../../lib/work-tasks";

type RouteContext = { params: Promise<{ taskId: string }> };
const cleanText = (value: unknown, maximum = 1000) => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const conflict = () => apiError("TASK_REVISION_CONFLICT", "这项任务刚有更新，请刷新后查看最新进度。", 409);

async function loadTask(identity: { authSubject: string }, organizationId: string, taskId: string) {
  if (!organizationId || !taskId) return apiError("TASK_SCOPE_REQUIRED", "缺少工作任务范围。", 400);
  const access = await getOrganizationAccess(identity.authSubject, organizationId);
  if (!access) return apiError("ACCESS_DENIED", "无权访问该公司的工作任务。", 403);
  const isAdmin = access.organizationRole === "admin";
  const task = await findWorkTask(organizationId, access.userId, isAdmin, taskId);
  if (!task) return apiError("TASK_NOT_FOUND", "没有找到这条工作任务。", 404);
  return { access, isAdmin, task };
}

export async function GET(request: Request, context: RouteContext) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再查看工作任务。", 401);
  try {
    const organizationId = cleanText(new URL(request.url).searchParams.get("organizationId"), 100);
    const { taskId } = await context.params;
    const result = await loadTask(identity, organizationId, taskId);
    if (result instanceof Response) return result;
    const history = await listWorkTaskUpdates(organizationId, result.access.userId, result.isAdmin, taskId);
    return Response.json({ workTask: result.task, history });
  } catch (error) {
    return errorResponse(error);
  }
}

function progressChange(task: WorkTask, payload: Record<string, unknown>, action: WorkTaskAction) {
  let status: WorkTaskStatus = task.workflow_status;
  let percent = task.progress_percent;
  let count: number | null = null;
  let mode = task.progress_mode;
  const note = cleanText(payload.note) || null;
  const nextStep = payload.nextStep === undefined ? task.next_step : cleanText(payload.nextStep) || null;
  const deliveryUrl = payload.deliveryUrl === undefined ? task.delivery_url : cleanText(payload.deliveryUrl, 2048) || null;
  let blocker = payload.blocker === undefined ? task.blocker : cleanText(payload.blocker) || null;

  if (deliveryUrl && !URL.canParse(deliveryUrl)) return apiError("TASK_URL_INVALID", "请填写完整的成果链接。", 400);
  if (deliveryUrl && !["https:", "http:"].includes(new URL(deliveryUrl).protocol)) return apiError("TASK_URL_INVALID", "成果链接需要以 https:// 或 http:// 开头。", 400);
  if (task.workflow_status === "cancelled") return apiError("TASK_CANCELLED", "这项任务已取消。", 409);

  if (action === "cancel") {
    status = "cancelled";
  } else if (action === "reopen") {
    if (status !== "completed") return apiError("TASK_NOT_COMPLETED", "只能重新打开已完成的任务。", 409);
    mode = "manual";
    status = "in_progress";
    percent = null;
    if (task.task_type === "custom") count = 0;
  } else if (action === "report") {
    if (status === "completed") return apiError("TASK_COMPLETED", "这项任务已完成，请重新打开后填报。", 409);
    percent = typeof payload.progressPercent === "number" ? payload.progressPercent : null;
    if (percent === null || !Number.isInteger(percent) || percent < 0 || percent > 100) return apiError("TASK_PROGRESS_INVALID", "请填写 0 到 100 的整数进度。", 400);
    if (!["pending", "in_progress", "waiting", "completed"].includes(String(payload.status))) return apiError("TASK_STATUS_INVALID", "请选择有效的工作状态。", 400);
    status = payload.status as WorkTaskStatus;
    if ((percent === 100) !== (status === "completed") || (status === "pending" && percent !== 0)) return apiError("TASK_PROGRESS_MISMATCH", "已完成的进度为 100%，待开始的进度为 0%。", 400);
    if (!note) return apiError("TASK_NOTE_REQUIRED", "请填写本次进展说明。", 400);
    if (status === "waiting" && !blocker) return apiError("TASK_BLOCKER_REQUIRED", "请写明正在等待的协作事项。", 400);
    mode = "manual";
  } else {
    // Legacy count clients may still update custom assignments.
    if (task.task_type !== "custom" || mode !== "count") return apiError("AUTOMATIC_TASK_PROGRESS", "实际业务数量由业务记录计算，请通过进度填报更新工作情况。", 409);
    count = action === "complete" ? task.target_count : Number(payload.completedCount);
    if (!Number.isInteger(count) || count < 0 || count > task.target_count) return apiError("TASK_PROGRESS_INVALID", "任务数量超出有效范围。", 400);
    status = count >= task.target_count ? "completed" : count > 0 ? "in_progress" : "pending";
    percent = status === "completed" ? 100 : null;
  }
  if (status !== "waiting") blocker = null;
  return { mode, status, percent, note, nextStep, blocker, deliveryUrl, count };
}

export async function PATCH(request: Request, context: RouteContext) {
  const identity = await readRequestIdentity(request);
  if (!identity) return apiError("AUTH_REQUIRED", "请先登录后再更新工作任务。", 401);
  try {
    const payload = await request.json() as Record<string, unknown>;
    const organizationId = cleanText(payload.organizationId, 100);
    const { taskId } = await context.params;
    const result = await loadTask(identity, organizationId, taskId);
    if (result instanceof Response) return result;
    const { access, isAdmin, task } = result;
    const action = cleanText(payload.action, 30) || (payload.completedCount !== undefined ? "count" : "");
    if (!["report", "cancel", "reopen", "complete", "count"].includes(action)) return apiError("TASK_ACTION_INVALID", "任务操作无效。", 400);
    if (action === "cancel" && !isAdmin) return apiError("ADMIN_REQUIRED", "只有公司管理员可以取消任务。", 403);
    if (action === "report" && task.assignee_user_id !== access.userId) return apiError("TASK_ASSIGNEE_REQUIRED", "仅负责人可以填写自己的工作进度。", 403);
    const requestId = payload.requestId ?? request.headers.get("Idempotency-Key");
    if (requestId != null && (typeof requestId !== "string" || !/^[\w.-]{1,128}$/.test(requestId))) return apiError("REQUEST_ID_INVALID", "进度提交标识无效。", 400);
    const signature = JSON.stringify([action, payload.expectedRevision ?? null, payload.progressPercent ?? null, payload.status ?? null,
      payload.note, payload.nextStep, payload.blocker, payload.deliveryUrl, payload.completedCount]);
    const db = getD1();
    async function replay() {
      if (!requestId) return null;
      const prior = await db.prepare("SELECT request_payload FROM work_task_updates WHERE task_id=? AND actor_user_id=? AND request_id=?")
        .bind(taskId, access.userId, requestId).first<{ request_payload: string }>();
      if (!prior) return null;
      if (signature !== prior.request_payload) return apiError("TASK_REQUEST_CONFLICT", "提交标识已用于其他进度内容。", 409);
      return Response.json({ workTask: await findWorkTask(organizationId, access.userId, isAdmin, taskId) });
    }
    const existing = await replay();
    if (existing) return existing;
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== task.revision) return conflict();
    const change = progressChange(task, payload, action as WorkTaskAction);
    if (change instanceof Response) return change;
    const { mode, status, percent, note, nextStep, blocker, deliveryUrl, count } = change;
    const now = new Date().toISOString();
    const updateId = crypto.randomUUID();
    const batch = await db.batch([
      db.prepare(`INSERT INTO work_task_updates (id,task_id,actor_user_id,action,previous_percent,progress_percent,status,note,next_step,blocker,delivery_url,created_at,request_id,request_payload)
        SELECT ?,t.id,?,?,?,?,?,?,?,?,?,?,?,? FROM work_tasks t WHERE t.id=? AND t.organization_id=? AND t.revision=?
        AND EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=t.organization_id
          AND m.user_id=? AND m.status='active' AND u.status='active' AND (m.role='admin' OR m.user_id=t.assignee_user_id)
          AND (?!='cancel' OR m.role='admin')
          AND (t.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id=t.project_id AND p.organization_id=t.organization_id
            AND p.status!='archived' AND p.deleted_at IS NULL AND (m.role='admin' OR EXISTS (SELECT 1 FROM project_members pm
            WHERE pm.project_id=p.id AND pm.organization_id=p.organization_id AND pm.user_id=m.user_id AND pm.status='active')))))
        ON CONFLICT(task_id,actor_user_id,request_id) DO NOTHING`).bind(updateId, access.userId, action, task.progress_percent, percent, status, note,
          nextStep, blocker, deliveryUrl, now, requestId, requestId ? signature : null, taskId, organizationId, task.revision, access.userId, action),
      db.prepare(`UPDATE work_tasks SET progress_mode=?,status=?,progress_percent=?,progress_note=?,next_step=?,blocker=?,delivery_url=?,
        completed_count=COALESCE(?,completed_count),updated_by=?,updated_at=?,revision=revision+1
        WHERE id=? AND EXISTS (SELECT 1 FROM work_task_updates WHERE id=? AND task_id=work_tasks.id)`)
        .bind(mode,status,percent,note,nextStep,blocker,deliveryUrl,count,access.userId,now,taskId,updateId),
      db.prepare(`INSERT INTO audit_logs (id,organization_id,project_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
        SELECT ?,?,?,actor_user_id,?,'work_task',task_id,?,created_at FROM work_task_updates WHERE id=?`)
        .bind(crypto.randomUUID(), organizationId, task.project_id, action === "cancel" ? "work_task.cancelled" : "work_task.progress_updated",
          JSON.stringify({ action, previousPercent: task.progress_percent, progressPercent: percent, completedCount: count }), updateId),
    ]);
    if (!batch[0].meta.changes) return await replay() ?? conflict();
    return Response.json({ workTask: await findWorkTask(organizationId, access.userId, isAdmin, taskId) });
  } catch (error) {
    return errorResponse(error);
  }
}
