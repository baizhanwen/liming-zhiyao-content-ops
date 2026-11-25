import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function setup(t) {
  const f = runtimeFixture(t);
  const owner = await f.initialize();
  const org = owner.organizationId;
  const now = new Date().toISOString();
  const add = (table, values) => {
    const columns = Object.keys(values);
    f.sqlite.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?")})`).run(...Object.values(values));
  };
  const timestamps = { created_at: now, updated_at: now };
  const context = { ...timestamps, organization_id: org, created_by: owner.userId, updated_by: owner.userId };
  function employee(name) {
    const id = crypto.randomUUID();
    add("users", { id, display_name: name, email: id + "@example.invalid", auth_subject: id, status: "active", ...timestamps });
    add("organization_members", { id: crypto.randomUUID(), user_id: id, role: "member", status: "active", ...context });
    return id;
  }
  const first = employee("测试甲"), second = employee("测试乙");
  const project = crypto.randomUUID();
  add("projects", { id: project, name: "测试空间", client_name: "测试", status: "active", ...context });
  add("project_members", { id: crypto.randomUUID(), user_id: first, project_id: project, role: "member", status: "active", ...context });
  f.identity.userId = owner.userId;
  f.runtime.getOrganizationAccess = async (user, organizationId) => f.sqlite.prepare(`SELECT user_id AS userId, organization_id AS organizationId, role AS organizationRole
    FROM organization_members WHERE organization_id=? AND user_id=? AND status='active'`).get(organizationId, user);
  const list = f.load("app/api/work-tasks/route.ts"), detail = f.load("app/api/work-tasks/[taskId]/route.ts");
  const request = (method, body) => new Request("http://localhost/api/work-tasks?organizationId=" + org, { method,
    ...(body ? { body: JSON.stringify({ organizationId: org, ...body }), headers: { "content-type": "application/json" } } : {}) });
  const params = id => ({ params: Promise.resolve({ taskId: id }) });
  const body = { title: "完成测试提纲", description: "整理资料", deliveryRequirements: "交付提纲", assigneeUserId: first, taskType: "topic",
    dueAt: "2099-01-01T00:00:00.000Z", priority: "high", projectId: project };
  return { f, owner, org, project, first, second, body, add, context, list: () => list.GET(request("GET")),
    create: (fields = {}) => list.POST(request("POST", { ...body, ...fields })), get: id => detail.GET(request("GET"), params(id)),
    patch: (id, fields) => detail.PATCH(request("PATCH", fields), params(id)) };
}

async function expectResponse(promise, status) {
  const response = await promise;
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

test("work board creates parallel assignments and retries exactly once within the authenticated organization", async t => {
  const { f, body, org, first, second, project, create, list, get, patch } = await setup(t);
  const args = { requestId: crypto.randomUUID() };
  const { workTask: one } = await expectResponse(create(args), 201);
  assert.equal(one.progress_percent, null);
  assert.equal(one.delivery_requirements, body.deliveryRequirements);
  assert.equal((await expectResponse(create(args), 200)).workTask.id, one.id);
  await expectResponse(create({ ...args, title: "不同要求" }), 409);
  const { workTask: two } = await expectResponse(create({ title: "其他提纲" }), 201);
  await expectResponse(create({ assigneeUserId: second }), 409);
  await expectResponse(create({ assigneeUserId: second, projectId: null }), 201);
  await expectResponse(create({ organizationId: "another-org" }), 403);
  await expectResponse(create({ title: "" }), 400);
  const team = await expectResponse(list(), 200);
  assert.equal(team.workTasks.length, 3);
  assert.equal(team.recentUpdates.length, 3);
  assert.deepEqual(team.projects, [{ id: project, name: "测试空间", memberIds: [first] }]);
  assert.deepEqual(team.employees.map(row => row.id).sort(), [first, second].sort());
  f.identity.userId = second;
  const own = await expectResponse(list(), 200);
  assert.equal(own.currentUserId, second);
  assert.equal(own.canAssign, false);
  assert.deepEqual(own.projects, []);
  assert.equal(own.workTasks.length, 1);
  assert.equal(own.recentUpdates.length, 1);
  assert.deepEqual(own.employees.map(row => row.id), [second]);
  await expectResponse(get(one.id), 404);
  await expectResponse(patch(two.id, { action: "report" }), 404);
  await expectResponse(create(), 403);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id=? AND action='work_task.created'").get(org).n, 3);
});

test("progress history separates business counts, explicit zero, waiting and overdue and survives completion/reopening", async t => {
  const { f, owner, project, first, create, list, get, patch, add, context } = await setup(t);
  const { workTask: task } = await expectResponse(create(), 201);
  add("topic_ideas", { ...context, id: crypto.randomUUID(), project_id: project, title: "测试选题", source_type: "manual", created_by: first,
    created_at: "2040-01-01T00:00:00.000Z" });
  const pending = (await expectResponse(get(task.id), 200)).workTask;
  assert.equal(pending.completed_count, 1);
  assert.equal(pending.workflow_status, "pending");
  assert.equal(pending.progress_percent, null);
  const zero = { action: "report", expectedRevision: 0, progressPercent: 0, status: "pending", note: "准备开始" };
  await expectResponse(patch(task.id, zero), 403);
  f.identity.userId = first;
  await expectResponse(patch(task.id, { ...zero, progressPercent: -1 }), 400);
  await expectResponse(patch(task.id, { ...zero, progressPercent: 37, status: "waiting" }), 400);
  await expectResponse(patch(task.id, { ...zero, deliveryUrl: "javascript:alert(1)" }), 400);
  assert.equal((await expectResponse(patch(task.id, zero), 200)).workTask.progress_percent, 0);
  const waiting = { ...zero, requestId: crypto.randomUUID(), expectedRevision: 1, progressPercent: 40, status: "waiting",
    note: "完成初版", nextStep: "校对", blocker: "等待复核", deliveryUrl: "https://example.invalid/draft" };
  const [r1, r2] = await Promise.all([patch(task.id, waiting), patch(task.id, waiting)]);
  await expectResponse(r1, 200); await expectResponse(r2, 200);
  await expectResponse(patch(task.id, { ...waiting, note: "发生变化" }), 409);
  await expectResponse(patch(task.id, { ...waiting, requestId: crypto.randomUUID() }), 409);
  f.sqlite.prepare("UPDATE work_tasks SET due_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(task.id);
  const board = await expectResponse(list(), 200);
  assert.equal(board.workTasks[0].workflow_status, "waiting");
  assert.equal(board.workTasks[0].is_overdue, true);
  assert.equal(board.workTasks[0].next_step, waiting.nextStep);
  const { history } = await expectResponse(get(task.id), 200);
  assert.deepEqual(history.map(row => [row.previous_percent, row.progress_percent]), [[0, 40], [null, 0], [null, null]]);
  assert.equal(history[0].actor_name, "测试甲");
  assert.equal(history[0].delivery_url, waiting.deliveryUrl);
  const completed = await expectResponse(patch(task.id, { ...zero, expectedRevision: 2, progressPercent: 100, status: "completed", note: "已交付" }), 200);
  assert.equal(completed.workTask.is_overdue, false);
  assert.equal(completed.workTask.blocker, null);
  await expectResponse(patch(task.id, { action: "cancel" }), 403);
  const reopened = await expectResponse(patch(task.id, { action: "reopen", expectedRevision: 3 }), 200);
  assert.equal(reopened.workTask.progress_percent, null);
  assert.equal(reopened.workTask.workflow_status, "in_progress");
  f.identity.userId = owner.userId;
  await expectResponse(patch(task.id, { action: "cancel", expectedRevision: 4 }), 200);
  assert.deepEqual((await expectResponse(get(task.id), 200)).history.map(row => row.action), ["cancel","reopen","report","report","report","created"]);
  f.identity.userId = first;
  await expectResponse(patch(task.id, { ...zero, expectedRevision: 5 }), 409);
  f.sqlite.prepare("DELETE FROM project_members WHERE user_id=? AND project_id=?").run(first, project);
  await expectResponse(get(task.id), 404);
  assert.deepEqual((await expectResponse(list(), 200)).recentUpdates, []);
});

test("the board includes every authorized assignment, limits only the recent activity excerpt", async t => {
  const { first, create, list } = await setup(t);
  for (let index = 0; index < 102; index++) {
    await expectResponse(create({ assigneeUserId: first, title: `测试任务 ${index}` }), 201);
  }
  const board = await expectResponse(list(), 200);
  assert.equal(board.workTasks.length, 102);
  assert.equal(board.recentUpdates.length, 20);
  assert.equal(board.recentUpdates[0].title, "测试任务 101");
});

test("the progress migration replays real legacy creation and manual audit events without inferring missing percentages", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const root = new URL("../drizzle/", import.meta.url);
  const migration = "0058_work_task_progress.sql";
  for (const name of readdirSync(root).filter(name => name.endsWith(".sql") && name < migration).sort()) {
    db.exec(readFileSync(new URL(name, root), "utf8"));
  }
  db.prepare("INSERT INTO users(id,auth_subject,email,status,created_at,updated_at) VALUES ('staff','staff','test@example.invalid','active','2026-01-01','2026-01-01')").run();
  db.prepare("INSERT INTO organizations(id,name,slug,status,created_by,created_at,updated_at) VALUES ('org','测试','test','active','staff','2026-01-01','2026-01-01')").run();
  db.prepare(`INSERT INTO work_tasks (id,organization_id,assignee_user_id,task_type,title,target_count,starts_at,due_at,created_by,updated_by,created_at,updated_at)
    VALUES ('old','org','staff','custom','旧派单',10,'2026-01-01','2026-12-01','staff','staff','2026-01-01','2026-03-01')`).run();
  const audit = db.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES (?,'org','staff','work_task.progress_updated','work_task','old',?,?)");
  audit.run("count", JSON.stringify({ completedCount: "2" }), "2026-02-01");
  audit.run("done", JSON.stringify({ action: "complete", completedCount: null }), "2026-03-01");
  audit.run("bad", "bad old metadata", "2026-03-02");
  db.exec(readFileSync(new URL(migration, root), "utf8"));
  assert.equal(db.prepare("SELECT progress_mode FROM work_tasks WHERE id='old'").get().progress_mode, "count");
  assert.deepEqual(db.prepare("SELECT action,status,progress_percent AS percent FROM work_task_updates ORDER BY created_at").all().map(row => ({ ...row })), [
    { action: "created", status: "pending", percent: null }, { action: "count", status: "in_progress", percent: null },
    { action: "complete", status: "completed", percent: 100 },
  ]);
});
