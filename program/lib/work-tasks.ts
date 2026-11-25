import { getD1 } from "../db/runtime";

export type WorkTaskStatus = "pending" | "in_progress" | "waiting" | "completed" | "cancelled";
export type WorkTaskAction = "created" | "report" | "reopen" | "cancel" | "complete" | "count";

export type WorkTaskHistory = {
  id: string;
  actor_name: string;
  created_at: string;
  action: WorkTaskAction;
  previous_percent: number | null;
  progress_percent: number | null;
  status: WorkTaskStatus;
  note: string | null;
  next_step: string | null;
  blocker: string | null;
  delivery_url: string | null;
};
export type WorkTaskRecentUpdate = WorkTaskHistory & { task_id: string; title: string };
export type WorkTaskBoard = {
  workTasks: WorkTask[];
  currentUserId: string;
  canAssign: boolean;
  employees: { id: string; name: string }[];
  projects: { id: string; name: string; memberIds: string[] }[];
  recentUpdates: WorkTaskRecentUpdate[];
};

export type WorkTask = {
  id: string;
  organization_id: string;
  project_id: string | null;
  project_name: string | null;
  assignee_user_id: string;
  assignee_name: string;
  task_type: "video_analysis" | "topic" | "content" | "review" | "publish" | "custom";
  title: string;
  description: string | null;
  target_count: number;
  completed_count: number;
  priority: "low" | "normal" | "high" | "urgent";
  status: WorkTaskStatus | "overdue";
  workflow_status: WorkTaskStatus;
  is_overdue: boolean;
  progress_mode: "count" | "manual";
  progress_percent: number | null;
  progress_note: string | null;
  next_step: string | null;
  blocker: string | null;
  delivery_url: string | null;
  delivery_requirements: string | null;
  revision: number;
  starts_at: string;
  due_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type WorkTaskQueryRow = Omit<WorkTask, "status" | "completed_count" | "is_overdue" | "workflow_status"> & {
  stored_status: string;
  computed_count: number;
};

export const workTaskTypes = ["video_analysis", "topic", "content", "review", "publish", "custom"] as const;
export const workTaskPriorities = ["low", "normal", "high", "urgent"] as const;

function taskVisibilitySql(isAdmin: boolean) {
  return `task.organization_id = ? AND (task.project_id IS NULL OR (project.id IS NOT NULL AND project.deleted_at IS NULL AND project.status != 'archived'))
    ${isAdmin ? "" : `AND task.assignee_user_id = ? AND (task.project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_members own WHERE own.project_id = task.project_id AND own.organization_id = task.organization_id
      AND own.user_id = task.assignee_user_id AND own.status = 'active'))`}`;
}

function workTaskProgressSql(isAdmin: boolean, byId = false) {
  return `
    SELECT task.id, task.organization_id, task.project_id, project.name AS project_name,
      task.assignee_user_id, COALESCE(NULLIF(user.display_name, ''), user.email) AS assignee_name,
      task.task_type, task.title, task.description, task.target_count, task.priority,
      task.progress_mode, task.progress_percent, task.progress_note, task.next_step, task.blocker, task.delivery_url, task.delivery_requirements, task.revision,
      task.status AS stored_status, task.starts_at, task.due_at, task.created_by, task.created_at, task.updated_at,
      CASE WHEN task.progress_mode = 'manual' AND task.project_id IS NULL THEN task.completed_count ELSE CASE task.task_type
        WHEN 'video_analysis' THEN (
          SELECT COUNT(*) FROM analysis_jobs job
          WHERE job.organization_id = task.organization_id AND job.created_by = task.assignee_user_id
            AND (task.project_id IS NULL OR job.project_id = task.project_id)
            AND job.created_at >= task.starts_at AND job.created_at <= task.due_at AND job.status = 'completed'
        )
        WHEN 'topic' THEN (
          SELECT COUNT(*) FROM topic_ideas topic
          WHERE topic.organization_id = task.organization_id AND topic.created_by = task.assignee_user_id
            AND (task.project_id IS NULL OR topic.project_id = task.project_id)
            AND topic.created_at >= task.starts_at AND topic.created_at <= task.due_at AND topic.deleted_at IS NULL
        )
        WHEN 'content' THEN (
          SELECT COUNT(*) FROM content_items content
          WHERE content.organization_id = task.organization_id AND content.created_by = task.assignee_user_id
            AND (task.project_id IS NULL OR content.project_id = task.project_id)
            AND content.created_at >= task.starts_at AND content.created_at <= task.due_at AND content.deleted_at IS NULL
        )
        WHEN 'review' THEN (
          SELECT COUNT(*) FROM content_reviews review
          WHERE review.organization_id = task.organization_id AND review.decided_by = task.assignee_user_id
            AND (task.project_id IS NULL OR review.project_id = task.project_id)
            AND review.decided_at >= task.starts_at AND review.decided_at <= task.due_at
            AND review.decision IN ('approved','changes_requested')
        )
        WHEN 'publish' THEN (
          SELECT COUNT(*) FROM publication_records publication
          WHERE publication.organization_id = task.organization_id AND publication.updated_by = task.assignee_user_id
            AND (task.project_id IS NULL OR publication.project_id = task.project_id)
            AND COALESCE(publication.published_at, publication.updated_at) >= task.starts_at
            AND COALESCE(publication.published_at, publication.updated_at) <= task.due_at AND publication.status = 'published'
        )
        ELSE task.completed_count
      END END AS computed_count
    FROM work_tasks task
    INNER JOIN users user ON user.id = task.assignee_user_id
    LEFT JOIN projects project ON project.id = task.project_id AND project.organization_id = task.organization_id
    WHERE ${taskVisibilitySql(isAdmin)}${byId ? " AND task.id = ?" : ""}
  `;
}

const workflowSql = `CASE WHEN stored_status = 'cancelled' THEN 'cancelled'
  WHEN progress_mode = 'manual' THEN stored_status
  WHEN computed_count >= MAX(target_count, 1) THEN 'completed'
  WHEN computed_count > 0 THEN 'in_progress' ELSE 'pending' END`;
const openSql = "workflow_status NOT IN ('completed','cancelled')";

function taskRowsSql(isAdmin: boolean, byId = false) {
  return `WITH task_progress AS (${workTaskProgressSql(isAdmin, byId)}),
    task_rows AS (SELECT task_progress.*, ${workflowSql} AS workflow_status FROM task_progress)`;
}

function mapWorkTask(row: WorkTaskQueryRow & { workflow_status: WorkTaskStatus }): WorkTask {
  const isOverdue = !["completed", "cancelled"].includes(row.workflow_status) && Date.parse(row.due_at) < Date.now();
  return {
    ...row, completed_count: Number(row.computed_count || 0),
    status: isOverdue ? "overdue" : row.workflow_status, is_overdue: isOverdue,
    progress_percent: row.workflow_status === "completed" ? 100 : row.progress_percent,
  };
}

/** Legacy dashboard counters and the board share completion rules. */
export async function readWorkTaskSummary(organizationId: string, userId: string, isAdmin: boolean, now = new Date().toISOString()) {
  const row = await getD1().prepare(`${taskRowsSql(isAdmin)} SELECT
    COUNT(CASE WHEN ${openSql} THEN 1 END) AS openWorkTasks,
    COUNT(CASE WHEN ${openSql} AND julianday(due_at) < julianday(?) THEN 1 END) AS overdueWorkTasks
    FROM task_rows`).bind(organizationId, ...(isAdmin ? [] : [userId]), now).first<{ openWorkTasks: number; overdueWorkTasks: number }>();
  return { openWorkTasks: Number(row?.openWorkTasks ?? 0), overdueWorkTasks: Number(row?.overdueWorkTasks ?? 0) };
}

export async function listWorkTasks(organizationId: string, userId: string, isAdmin: boolean, limit: number | null = 50): Promise<WorkTask[]> {
  const rows = await getD1().prepare(`${taskRowsSql(isAdmin)} SELECT * FROM task_rows
    ORDER BY CASE WHEN workflow_status = 'cancelled' THEN 3 WHEN workflow_status = 'completed' THEN 2
      WHEN julianday(due_at) < julianday('now') THEN 0 ELSE 1 END, due_at ASC, created_at DESC, id ASC
    ${limit == null ? "" : "LIMIT ?"}`).bind(organizationId, ...(isAdmin ? [] : [userId]), ...(limit == null ? [] : [Math.max(1, Math.min(100, limit))]))
    .all<WorkTaskQueryRow & { workflow_status: WorkTaskStatus }>();
  return rows.results.map(mapWorkTask);
}

export async function findWorkTask(organizationId: string, userId: string, isAdmin: boolean, taskId: string) {
  const row = await getD1().prepare(`${taskRowsSql(isAdmin, true)} SELECT * FROM task_rows`)
    .bind(organizationId, ...(isAdmin ? [] : [userId]), taskId).first<WorkTaskQueryRow & { workflow_status: WorkTaskStatus }>();
  return row ? mapWorkTask(row) : null;
}

export async function listWorkTaskUpdates(organizationId: string, userId: string, isAdmin: boolean, taskId?: string) {
  const rows = await getD1().prepare(`SELECT entry.id, entry.task_id, task.title, entry.action, entry.previous_percent, entry.progress_percent,
    entry.status, entry.note, entry.next_step, entry.blocker, entry.delivery_url, entry.created_at,
    COALESCE(NULLIF(actor.display_name,''), actor.email) AS actor_name
    FROM work_task_updates entry INNER JOIN work_tasks task ON task.id = entry.task_id
    INNER JOIN users actor ON actor.id = entry.actor_user_id
    LEFT JOIN projects project ON project.id = task.project_id AND project.organization_id = task.organization_id
    WHERE ${taskVisibilitySql(isAdmin)}${taskId ? " AND task.id = ?" : ""}
    ORDER BY entry.created_at DESC, entry.rowid DESC ${taskId ? "" : "LIMIT 20"}`)
    .bind(organizationId, ...(isAdmin ? [] : [userId]), ...(taskId ? [taskId] : [])).all<WorkTaskRecentUpdate>();
  return rows.results;
}

export async function readWorkTaskBoard(organizationId: string, userId: string, isAdmin: boolean): Promise<WorkTaskBoard> {
  const db = getD1();
  const [workTasks, recentUpdates, employees, memberships] = await Promise.all([
    listWorkTasks(organizationId, userId, isAdmin, null), listWorkTaskUpdates(organizationId, userId, isAdmin),
    db.prepare(`SELECT u.id, COALESCE(NULLIF(u.display_name,''), u.email) AS name
      FROM organization_members member JOIN users u ON u.id = member.user_id
      WHERE member.organization_id = ? AND member.status = 'active' AND u.status = 'active' AND member.role = 'member'
      ${isAdmin ? "" : "AND member.user_id = ?"} ORDER BY name, u.id`).bind(organizationId, ...(isAdmin ? [] : [userId])).all<{ id: string; name: string }>(),
    db.prepare(`SELECT p.id, p.name, member.user_id AS userId FROM projects p
      ${isAdmin ? "LEFT JOIN" : "INNER JOIN"} project_members member ON member.project_id = p.id AND member.organization_id = p.organization_id
      AND member.status = 'active' ${isAdmin ? "" : "AND member.user_id = ?"}
      WHERE p.organization_id = ? AND p.deleted_at IS NULL AND p.status != 'archived' ORDER BY p.name, p.id, member.user_id`)
      .bind(...(isAdmin ? [] : [userId]), organizationId).all<{ id: string; name: string; userId: string | null }>(),
  ]);
  const projects = new Map<string, WorkTaskBoard["projects"][number]>();
  for (const row of memberships.results) {
    const project = projects.get(row.id) ?? { id: row.id, name: row.name, memberIds: [] };
    if (row.userId) project.memberIds.push(row.userId);
    projects.set(row.id, project);
  }
  return { workTasks, canAssign: isAdmin, currentUserId: userId, employees: employees.results, projects: [...projects.values()], recentUpdates };
}
