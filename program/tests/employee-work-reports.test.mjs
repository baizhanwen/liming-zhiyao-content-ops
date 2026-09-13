import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("employee reports persist separately from enterprise performance reports", async () => {
  const [schema, migration, route] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0036_employee_work_reports.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/employee-reports/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const employeeWorkReports/);
  assert.match(schema, /employeeUserId: text\("employee_user_id"\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `employee_work_reports`/);
  assert.match(route, /employee_user_id = \?/);
  assert.match(route, /employeeUserId !== access\.userId && !canViewTeam/);
});

test("employee outcomes use real actor attribution and cohort-based performance gates", async () => {
  const source = await readFile(new URL("../lib/employee-work-report.ts", import.meta.url), "utf8");
  assert.match(source, /aj\.created_by = \?/);
  assert.match(source, /COALESCE\(ci\.assignee_user_id, ci\.created_by\)/);
  assert.match(source, /work\.owner_user_id === employeeUserId/);
  assert.match(source, /works\.length >= 10/);
  assert.match(source, /work\.views >= p90Views/);
  assert.match(source, /work\.engagementRate >= p75EngagementRate/);
  assert.match(source, /works\.length >= 5/);
  assert.match(source, /暂不做高表现判定/);
});

test("report center exposes enterprise and employee report modes", async () => {
  const workspace = await readFile(new URL("../components/InsightsWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /企业运营报告/);
  assert.match(workspace, /员工工作报告/);
  assert.match(workspace, /主创内容/);
  assert.match(workspace, /结果归因/);
  assert.match(workspace, /统计与爆款判定口径/);
});

test("enterprise report follows judgment, result, action, and evidence hierarchy", async () => {
  const workspace = await readFile(new URL("../components/InsightsWorkspace.tsx", import.meta.url), "utf8");
  const judgment = workspace.indexOf('<section className="report-brief"');
  const result = workspace.indexOf('<section className="report-result-block"');
  const action = workspace.indexOf('<section className="report-decision-block"');
  const evidence = workspace.indexOf('<header><div><span>判断依据</span>');
  assert.ok(judgment >= 0 && judgment < result);
  assert.ok(result < action);
  assert.ok(action < evidence);
  assert.match(workspace, /查看完整诊断/);
  assert.match(workspace, /highlights\.slice\(0, 3\)/);
  assert.match(workspace, /recommendations\.slice\(0, 3\)/);
});
