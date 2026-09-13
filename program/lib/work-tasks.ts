import { getD1 } from "../db/runtime";

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
  status: "pending" | "in_progress" | "completed" | "overdue" | "cancelled";
  starts_at: string;
  due_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type WorkTaskQueryRow = Omit<WorkTask, "status" | "completed_count"> & {
  stored_status: string;
  computed_count: number;
};

export const workTaskTypes = ["video_analysis", "topic", "content", "review", "publish", "custom"] as const;
export const workTaskPriorities = ["low", "normal", "high", "urgent"] as const;

export function deriveWorkTaskStatus(storedStatus: string, completedCount: number, targetCount: number, dueAt: string): WorkTask["status"] {
  if (storedStatus === "cancelled") return "cancelled";
  if (completedCount >= targetCount) return "completed";
  if (new Date(dueAt).getTime() < Date.now()) return "overdue";
  if (completedCount > 0) return "in_progress";
  return "pending";
}

export async function listWorkTasks(organizationId: string, userId: string, isAdmin: boolean, limit = 50): Promise<WorkTask[]> {
  const scope = isAdmin ? "" : " AND task.assignee_user_id = ?";
  const bindings: unknown[] = [organizationId];
  if (!isAdmin) bindings.push(userId);
  bindings.push(Math.max(1, Math.min(100, limit)));
  const rows = await getD1().prepare(`
    SELECT task.id, task.organization_id, task.project_id, project.name AS project_name,
      task.assignee_user_id, COALESCE(NULLIF(user.display_name, ''), user.email) AS assignee_name,
      task.task_type, task.title, task.description, task.target_count, task.priority,
      task.status AS stored_status, task.starts_at, task.due_at, task.created_by, task.created_at, task.updated_at,
      CASE task.task_type
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
      END AS computed_count
    FROM work_tasks task
    INNER JOIN users user ON user.id = task.assignee_user_id
    LEFT JOIN projects project ON project.id = task.project_id AND project.organization_id = task.organization_id
    WHERE task.organization_id = ?${scope}
    ORDER BY CASE task.status WHEN 'cancelled' THEN 2 ELSE 0 END,
      CASE WHEN julianday(task.due_at) < julianday('now') THEN 0 ELSE 1 END, task.due_at ASC, task.created_at DESC
    LIMIT ?
  `).bind(...bindings).all<WorkTaskQueryRow>();

  return rows.results.map((row) => {
    const completedCount = Number(row.computed_count || 0);
    const targetCount = Number(row.target_count || 1);
    return {
      ...row,
      target_count: targetCount,
      completed_count: completedCount,
      status: deriveWorkTaskStatus(row.stored_status, completedCount, targetCount, row.due_at),
    };
  });
}
