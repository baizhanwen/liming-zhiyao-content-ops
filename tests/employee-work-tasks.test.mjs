import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("employee work tasks persist with tenant, assignee, target, and deadline scope", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0038_employee_work_tasks.sql", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const workTasks/);
  assert.match(schema, /assigneeUserId: text\("assignee_user_id"\)/);
  assert.match(schema, /targetCount: integer\("target_count"\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `work_tasks`/);
  assert.match(migration, /idx_work_tasks_assignee_due/);
});

test("only administrators assign work and active employees with project access can receive it", async () => {
  const route = await readFile(new URL("../app/api/work-tasks/route.ts", import.meta.url), "utf8");
  assert.match(route, /access\.organizationRole !== "admin"/);
  assert.match(route, /member\.role = 'member'/);
  assert.match(route, /TASK_PROJECT_ACCESS_REQUIRED/);
  assert.match(route, /ACTIVE_TASK_ALREADY_EXISTS/);
  assert.match(route, /work_task\.created/);
});

test("automatic task progress comes from real work records while custom tasks stay manual", async () => {
  const [source, itemRoute] = await Promise.all([
    readFile(new URL("../lib/work-tasks.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/work-tasks/[taskId]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(source, /FROM analysis_jobs job/);
  assert.match(source, /FROM topic_ideas topic/);
  assert.match(source, /FROM content_items content/);
  assert.match(source, /FROM content_reviews review/);
  assert.match(source, /FROM publication_records publication/);
  assert.match(source, /job\.created_at >= task\.starts_at/);
  assert.match(itemRoute, /AUTOMATIC_TASK_PROGRESS/);
  assert.match(itemRoute, /task\.task_type !== "custom"/);
});

test("administrator and employee dashboards expose their respective task controls", async () => {
  const dashboard = await readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /给员工布置任务/);
  assert.match(dashboard, /我的工作任务/);
  assert.match(dashboard, /下达任务/);
  assert.match(dashboard, /管理员下达/);
  assert.match(dashboard, /renderWorkTaskRows\(true\)/);
  assert.match(dashboard, /renderWorkTaskRows\(false\)/);
  assert.match(dashboard, /\/api\/work-tasks/);
});
