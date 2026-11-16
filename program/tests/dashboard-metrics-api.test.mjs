import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";

async function fixture(t) {
  const f = runtimeFixture(t), owner = await f.initialize(); f.identity.userId = owner.userId;
  const now = new Date().toISOString();
  function seed(table, fields = {}) {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: owner.organizationId, created_by: owner.userId, updated_by: owner.userId, created_at: now, updated_at: now, ...fields }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  }
  const project = (fields = {}) => seed("projects", { name: "Synthetic project", client_name: "Synthetic", status: "active", ...fields });
  const employee = (fields = {}, membership = {}) => {
    const id = seed("users", { auth_subject: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.invalid`, display_name: "Synthetic employee", status: "active", ...fields });
    seed("organization_members", { user_id: id, role: "member", status: "active", ...membership }); return id;
  };
  const member = (user, projectId) => seed("project_members", { user_id: user, project_id: projectId, role: "member", status: "active" });
  const video = (projectId, fields = {}) => seed("videos", { project_id: projectId, platform: "douyin", source_type: "url", source_url: "https://example.invalid/synthetic", title: "Synthetic video", status: "ready", ...fields });
  const job = (videoId, projectId, fields = {}) => seed("analysis_jobs", { video_id: videoId, project_id: projectId, source_type: "url", source_ref: "https://example.invalid/synthetic", idempotency_key: `main:${crypto.randomUUID()}`, status: "completed", ...fields });
  const content = (projectId, fields = {}) => {
    const topicId = seed("topic_ideas", { project_id: projectId, title: "Synthetic topic", source_type: "manual" });
    return seed("content_items", { project_id: projectId, topic_id: topicId, title: "Synthetic content", status: "draft", ...fields });
  };
  const version = (contentId, projectId) => f.sqlite.prepare("SELECT id FROM content_versions WHERE content_item_id=? LIMIT 1").get(contentId)?.id
    ?? seed("content_versions", { project_id: projectId, content_item_id: contentId, version: 1, generation_mode: "manual", pack_json: "{}", full_script: "Synthetic", short_script: "Synthetic", prompt_version: "synthetic" });
  const work = (userId, projectId, fields = {}) => seed("work_tasks", { project_id: projectId, assignee_user_id: userId, task_type: "custom", title: "Synthetic assignment", target_count: 1, completed_count: 0, priority: "normal", status: "pending", starts_at: "2020-01-01T00:00:00.000Z", due_at: "2090-01-01T00:00:00.000Z", ...fields });
  f.runtime.getOrganizationAccess = async (_subject, organizationId) => f.sqlite.prepare(`SELECT om.user_id AS userId,om.organization_id AS organizationId,om.role AS organizationRole
    FROM organization_members om INNER JOIN users u ON u.id=om.user_id WHERE om.organization_id=? AND om.user_id=? AND om.status='active' AND u.status='active'`).get(organizationId, f.identity.userId) ?? null;
  f.runtime.ensureUser = async () => f.sqlite.prepare("SELECT * FROM users WHERE id=?").get(f.identity.userId);
  const read = (org = owner.organizationId) => f.load("app/api/dashboard/route.ts").GET(new Request(`http://localhost/dashboard?organizationId=${org}`));
  const data = async () => { const response = await read(); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  return { ...f, owner, now, seed, project, employee, member, video, job, content, version, work, read, data };
}

test("dashboard current failures use the newest main analysis and utility transcription cannot hide them", async t => {
  const f = await fixture(t), project = f.project();
  const repaired = f.video(project);
  const oldFailed = f.job(repaired, project, { status: "failed", created_at: "2020-01-01T00:00:00.000Z", updated_at: "2090-01-01T00:00:00.000Z" });
  const repairedJob = f.job(repaired, project, { status: "completed", created_at: "2021-01-01T00:00:00.000Z" });
  const failed = f.video(project), currentFailed = f.job(failed, project, { status: "failed", created_at: "2021-01-01T00:00:00.000Z" });
  const utility = f.job(failed, project, { idempotency_key: "transcript:utility", status: "completed", created_at: "2022-01-01T00:00:00.000Z" });
  const partial = f.video(project), partialJob = f.job(partial, project, { status: "partial" });
  const pending = f.video(project), activeJob = f.job(pending, project, { status: "pending" });
  const result = await f.data();
  assert.equal(result.summary.currentFailedJobs, 1); assert.equal(result.summary.partialJobs, 1); assert.equal(result.summary.activeJobs, 1);
  assert.equal(result.summary.historicalFailedJobs, 2); assert.equal(result.summary.failedJobs, 2);
  assert.deepEqual(result.jobs.slice(0, 3).map(row => row.id), [currentFailed, partialJob, activeJob]);
  assert.ok(result.jobs.some(row => row.id === repairedJob)); assert.ok(!result.jobs.some(row => [oldFailed, utility].includes(row.id)));
  assert.equal(result.jobs[0].video_id, failed); assert.equal(result.jobs[0].project_id, project);
});

test("dashboard resolves equal creation timestamps deterministically and limits completed previews", async t => {
  const f = await fixture(t), project = f.project(), video = f.video(project);
  f.job(video, project, { status: "failed" }); const replacement = f.job(video, project, { status: "completed" });
  for (let index = 0; index < 5; index += 1) f.job(f.video(project), project);
  const result = await f.data();
  assert.equal(result.summary.currentFailedJobs, 0); assert.equal(result.summary.historicalFailedJobs, 1);
  assert.equal(result.jobs.filter(row => row.status === "completed").length, 2);
  assert.ok(!result.jobs.some(row => row.video_id === video && row.id !== replacement));
});

test("deleted videos and deleted or archived projects never enter current or historical analysis totals", async t => {
  const f = await fixture(t), active = f.project(), deleted = f.project({ deleted_at: f.now }), archived = f.project({ status: "archived" });
  for (const [project, deletedAt] of [[deleted, null], [archived, null], [active, f.now]]) {
    for (const status of ["failed", "partial", "pending"]) f.job(f.video(project, { deleted_at: deletedAt }), project, { status });
    f.content(project, { deleted_at: deletedAt });
    f.work(f.owner.userId, project);
  }
  const kept = f.job(f.video(active), active, { status: "failed" });
  const result = await f.data();
  assert.equal(result.summary.currentFailedJobs, 1); assert.equal(result.summary.historicalFailedJobs, 1);
  assert.equal(result.summary.activeJobs, 0); assert.equal(result.summary.partialJobs, 0);
  assert.deepEqual(result.jobs.map(row => row.id), [kept]); assert.equal(result.projects.length, 1);
  assert.equal(result.summary.openTasks, 0); assert.equal(result.summary.openWorkTasks, 1);
  assert.equal(result.team.find(row => row.id === f.owner.userId).active_jobs, 0);
});

test("employee data stays own-scoped while pending reviews remain project-scoped", async t => {
  const f = await fixture(t), shared = f.project({ content_target: 10 }), privateProject = f.project({ content_target: 20 });
  const employee = f.employee(), other = f.employee(); f.member(employee, shared); f.member(other, privateProject);
  const ownJob = f.job(f.video(shared), shared, { status: "failed", created_by: employee });
  f.job(f.video(shared), shared, { status: "failed", created_by: other });
  f.job(f.video(privateProject), privateProject, { status: "failed", created_by: employee });
  const ownContent = f.content(shared, { assignee_user_id: employee }), otherContent = f.content(shared, { assignee_user_id: other });
  const hiddenContent = f.content(privateProject, { assignee_user_id: employee });
  for (const [content, project] of [[ownContent, shared], [otherContent, shared], [hiddenContent, privateProject]]) {
    f.seed("content_reviews", { project_id: project, content_item_id: content, content_version_id: f.version(content, project), review_stage: "internal", round: 1, decision: "pending", requested_at: f.now, requested_by: f.owner.userId });
  }
  f.work(employee, shared); f.work(other, shared); f.identity.userId = employee;
  const result = await f.data();
  assert.equal(result.mode, "employee"); assert.equal(result.summary.currentFailedJobs, 1); assert.equal(result.summary.failedJobs, 1);
  assert.deepEqual(result.jobs.map(row => row.id), [ownJob]); assert.deepEqual(result.tasks.map(row => row.id), [ownContent]);
  assert.equal(result.summary.openWorkTasks, 1); assert.equal(result.summary.openTasks, 1);
  assert.equal(result.summary.pendingReviews, 2); assert.equal(result.reviews.length, 2); assert.ok(result.reviews.every(row => row.project_id === shared));
  assert.deepEqual(result.assignableEmployees, []); assert.deepEqual(result.team, []); assert.equal(result.summary.monthlyContentTarget, 10);
});

test("a coworker's newer main completion resolves an employee's old failure without exposing the coworker's task", async t => {
  const f = await fixture(t), project = f.project(), employee = f.employee(), other = f.employee(); f.member(employee, project);
  const video = f.video(project); f.job(video, project, { status: "failed", created_by: employee, created_at: "2020-01-01T00:00:00.000Z" });
  f.job(video, project, { status: "completed", created_by: other, created_at: "2021-01-01T00:00:00.000Z" }); f.identity.userId = employee;
  const result = await f.data(); assert.equal(result.summary.currentFailedJobs, 0); assert.equal(result.summary.historicalFailedJobs, 1); assert.deepEqual(result.jobs, []);
});

test("assignable employees are complete and independent from the eight-person load preview", async t => {
  const f = await fixture(t); const expected = [];
  for (let index = 0; index < 13; index += 1) expected.push(f.employee({ display_name: `Employee ${index}` }));
  f.employee({ status: "suspended" }); f.employee({}, { status: "suspended" });
  const result = await f.data(); assert.equal(result.team.length, 8);
  assert.deepEqual(result.assignableEmployees.map(row => row.id).sort(), expected.sort());
});

test("work-task totals count beyond fifty rows and exclude derived completion and cancellation", async t => {
  const f = await fixture(t), project = f.project();
  for (let index = 0; index < 55; index += 1) f.work(f.owner.userId, project);
  f.work(f.owner.userId, project, { due_at: "2020-01-01T00:00:01.000Z" });
  f.work(f.owner.userId, project, { status: "cancelled" }); f.work(f.owner.userId, project, { completed_count: 1 });
  const result = await f.data(); assert.equal(result.summary.openWorkTasks, 56); assert.equal(result.summary.overdueWorkTasks, 1);
  const list = await f.load("lib/work-tasks.ts").listWorkTasks(f.owner.organizationId, f.owner.userId, true);
  assert.equal(list.length, 50); assert.ok(list.every(row => !["completed", "cancelled"].includes(row.status)));
});

test("automatic completed rows cannot crowd unfinished tasks out before the fifty-row page limit", async t => {
  const f = await fixture(t), project = f.project(); f.content(project, { created_at: "2020-01-02T00:00:00.000Z" });
  for (let index = 0; index < 60; index += 1) f.work(f.owner.userId, project, { task_type: "content", status: "pending", due_at: "2020-01-03T00:00:00.000Z" });
  const pending = f.work(f.owner.userId, project);
  const tasks = f.load("lib/work-tasks.ts"), list = await tasks.listWorkTasks(f.owner.organizationId, f.owner.userId, true);
  assert.equal(list.length, 50); assert.equal(list[0].id, pending); assert.equal(list[0].status, "pending"); assert.ok(list.slice(1).every(row => row.status === "completed"));
  const result = await f.data(); assert.equal(result.summary.openWorkTasks, 1); assert.equal(result.summary.overdueWorkTasks, 0);
});

test("monthly production uses actual publication events, distinct content and the Shanghai calendar", async t => {
  const f = await fixture(t), range = f.load("lib/dashboard-period.ts").dashboardMonthRange;
  assert.deepEqual(range(new Date("2026-11-30T16:00:00.000Z")), { start: "2026-11-30T16:00:00.000Z", end: "2026-12-31T16:00:00.000Z" });
  assert.deepEqual(range(new Date("2026-11-30T15:59:59.999Z")), { start: "2026-10-31T16:00:00.000Z", end: "2026-11-30T16:00:00.000Z" });
  const month = range(new Date()), project = f.project({ content_target: 10 });
  const publish = (content, date, fields = {}) => f.seed("publication_records", { project_id: project, content_item_id: content, content_version_id: f.version(content, project), platform: "douyin", status: "published", published_at: date, ...fields });
  const current = f.content(project, { status: "published" }); publish(current, month.start); publish(current, f.now, { platform: "channels" });
  const reviewed = f.content(project, { status: "reviewed" }); publish(reviewed, f.now);
  const merelyEdited = f.content(project, { status: "published", updated_at: f.now }); publish(merelyEdited, new Date(Date.parse(month.start) - 1).toISOString());
  const nextMonth = f.content(project, { status: "published" }); publish(nextMonth, month.end);
  const deleted = f.content(project, { status: "published", deleted_at: f.now }); publish(deleted, f.now);
  f.content(project, { status: "published" });
  const result = await f.data(); assert.equal(result.summary.publishedMonth, 2); assert.equal(result.projects[0].published_month, 2); assert.equal(result.summary.monthlyContentTarget, 10);
});

test("employee publication totals stay personal while project goals and progress stay project-wide", async t => {
  const f = await fixture(t), project = f.project({ content_target: 10 }), privateProject = f.project({ content_target: 30 });
  const employee = f.employee(), other = f.employee(); f.member(employee, project);
  for (const [assignee, projectId] of [[employee, project], [other, project], [employee, privateProject]]) {
    const content = f.content(projectId, { assignee_user_id: assignee, status: "published" });
    f.seed("publication_records", { project_id: projectId, content_item_id: content, content_version_id: f.version(content, projectId), platform: "douyin", status: "published", published_at: f.now });
  }
  f.identity.userId = employee; const result = await f.data();
  assert.equal(result.summary.publishedMonth, 1); assert.equal(result.summary.monthlyContentTarget, 10);
  assert.equal(result.projects.length, 1); assert.equal(result.projects[0].published_month, 2);
});

for (const [boundary, delta, expected] of [["start", -1, 0], ["start", 0, 1], ["end", -1, 1], ["end", 0, 0]]) {
  test(`publication offset and UTC timestamps agree at month ${boundary} ${delta}ms`, async t => {
    const f = await fixture(t), project = f.project(), month = f.load("lib/dashboard-period.ts").dashboardMonthRange(new Date());
    const instant = Date.parse(month[boundary]) + delta;
    const utc = new Date(instant).toISOString();
    const shanghai = new Date(instant + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
    assert.equal(Date.parse(shanghai), Date.parse(utc));
    for (const publishedAt of [utc, shanghai]) {
      const content = f.content(project, { status: "published" });
      f.seed("publication_records", { project_id: project, content_item_id: content, content_version_id: f.version(content, project), platform: "douyin", status: "published", published_at: publishedAt });
      const result = await f.data();
      const count = publishedAt === utc ? expected : expected * 2;
      assert.equal(result.summary.publishedMonth, count, publishedAt);
      assert.equal(result.projects[0].published_month, count, publishedAt);
    }
  });
}

test("dashboard denies another organization without reading its summaries", async t => {
  const f = await fixture(t), response = await f.read("another-organization"); assert.equal(response.status, 403);
});
