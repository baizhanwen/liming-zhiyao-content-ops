import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("dashboard separates administrator operations from employee work", async () => {
  const [dashboard, route, styles] = await Promise.all([
    readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-workspace.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /role-dashboard home-dashboard/);
  assert.match(dashboard, /className="page-heading management-heading home-heading"/);
  assert.match(dashboard, /className="management-toolbar home-context"/);
  assert.match(dashboard, /处理待办、查看运营进度，从这里开始今天的工作。/);
  assert.match(dashboard, /工作台/);
  assert.match(dashboard, /我的工作台/);
  assert.match(dashboard, /常用操作/);
  assert.match(dashboard, /项目待审核/);
  assert.match(dashboard, /团队待办/);
  assert.match(dashboard, /dashboard.summary.openWorkTasks/);
  assert.match(dashboard, /dashboard\?\.assignableEmployees/);
  assert.match(dashboard, /home-completed-tasks/);
  for (const anchor of ["home-reviews", "work-tasks", "home-analysis", "home-monthly"]) {
    assert.ok(dashboard.includes(`href="#${anchor}"`));
    assert.ok(dashboard.includes(`id="${anchor}"`));
  }
  assert.match(dashboard, /我的内容任务/);
  assert.match(dashboard, /我的备忘/);
  assert.match(styles, /\.home-stats \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.home-assignment-disclosure:not\(\[open\]\)/);

  assert.match(route, /mode: isAdmin \? "admin" : "employee"/);
  assert.match(route, /j\.created_by = \?/);
  assert.match(route, /COALESCE\(\$\{alias\}\.assignee_user_id, \$\{alias\}\.created_by\) = \?/);
  assert.match(route, /reviewer\.user_id = \? AND reviewer\.status = 'active'/);
  assert.doesNotMatch(route, /reviewer\.role IN/);
  assert.match(route, /canCreateContent/);
  assert.match(route, /team: team\.results/);
});
