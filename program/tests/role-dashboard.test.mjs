import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("dashboard separates administrator operations from employee work", async () => {
  const [dashboard, route, styles] = await Promise.all([
    readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /运营总览/);
  assert.match(dashboard, /我的工作台/);
  assert.match(dashboard, /公司推进状态/);
  assert.match(dashboard, /我的推进清单/);
  assert.match(dashboard, /团队负载/);
  assert.match(dashboard, /我的内容任务/);
  assert.match(dashboard, /我的备忘/);
  assert.match(styles, /\.dashboard-command-strip \{[^}]*grid-auto-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /\.dashboard-command-strip \{[^}]*repeat\(5/);

  assert.match(route, /mode: isAdmin \? "admin" : "employee"/);
  assert.match(route, /j\.created_by = \?/);
  assert.match(route, /COALESCE\(\$\{alias\}\.assignee_user_id, \$\{alias\}\.created_by\) = \?/);
  assert.match(route, /reviewer\.user_id = \? AND reviewer\.status = 'active'/);
  assert.doesNotMatch(route, /reviewer\.role IN/);
  assert.match(route, /canCreateContent/);
  assert.match(route, /team: team\.results/);
});
