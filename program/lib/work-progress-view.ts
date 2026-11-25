import type { WorkTask } from "./work-tasks";

const chinaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
export function deadlineState(task: WorkTask, now: number) {
  if (task.workflow_status === "completed" || task.workflow_status === "cancelled") return "";
  const due = Date.parse(task.due_at);
  if (due < now) return "overdue";
  return Number.isFinite(due) && chinaDay.format(due) === chinaDay.format(now) ? "today" : "";
}

export function summarizeWorkTasks(tasks: WorkTask[], now: number) {
  let open = 0, waiting = 0, today = 0, overdue = 0, known = 0, unknown = 0, sum = 0;
  for (const task of tasks) {
    if (task.workflow_status === "cancelled") continue;
    const completed = task.workflow_status === "completed";
    if (!completed) open++;
    if (task.workflow_status === "waiting") waiting++;
    const deadline = deadlineState(task, now);
    if (deadline === "overdue") overdue++;
    if (deadline === "today") today++;
    const percent = completed ? 100 : task.progress_percent;
    if (percent == null) unknown++;
    else { known++; sum += percent; }
  }
  return { open, waiting, today, overdue, known, unknown, average: known ? Math.round(sum / known) : null };
}
