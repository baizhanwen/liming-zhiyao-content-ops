import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deadlineState, summarizeWorkTasks } from "../lib/work-progress-view.ts";

test("dashboard separates administrator operations from employee work", async () => {
  const [dashboard, route, styles] = await Promise.all([
    readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-workspace.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /aria-label="公司"/);
  assert.match(dashboard, /aria-label="任务摘要"/);
  assert.match(dashboard, /isAdmin && <Filter label="员工"/);
  assert.match(dashboard, /<details className="wp-recent"><summary>/);
  assert.match(dashboard, /我的备忘/);
  assert.doesNotMatch(dashboard, /DashboardTrend|home-reviews|home-analysis|home-monthly/);
  assert.match(styles, /@container progress-home/);

  assert.match(route, /mode: isAdmin \? "admin" : "employee"/);
  assert.match(route, /j\.created_by = \?/);
  assert.match(route, /COALESCE\(\$\{alias\}\.assignee_user_id, \$\{alias\}\.created_by\) = \?/);
  assert.match(route, /reviewer\.user_id = \? AND reviewer\.status = 'active'/);
  assert.doesNotMatch(route, /reviewer\.role IN/);
  assert.match(route, /canCreateContent/);
  assert.match(route, /team: team\.results/);
});

test("progress summary distinguishes missing reports from zero and excludes cancelled tasks", () => {
  const now = Date.parse("2026-11-21T03:00:00Z");
  const due = "2026-11-22T00:00:00Z";
  const task = (workflow_status, progress_percent, due_at = due) => ({ workflow_status, progress_percent, due_at });
  const tasks = [
    task("pending", null, "2026-11-21T02:59:00Z"), task("in_progress", 0),
    task("waiting", 50, "2026-11-21T15:00:00Z"), task("completed", null), task("cancelled", 80),
  ];
  assert.deepEqual(summarizeWorkTasks(tasks, now), { open: 3, waiting: 1, today: 1, overdue: 1, known: 3, unknown: 1, average: 50 });
  assert.equal(summarizeWorkTasks([tasks[0]], now).average, null);
  assert.equal(summarizeWorkTasks([tasks[1]], now).average, 0);
  assert.equal(summarizeWorkTasks([tasks[4]], now).unknown, 0);
  assert.equal(deadlineState(task("completed", 100, "2020-01-01T00:00:00Z"), now), "");
  assert.equal(deadlineState(task("pending", null, "2026-11-21T16:00:00Z"), now), "");
});
