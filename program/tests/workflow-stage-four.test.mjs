import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import * as workflow from "../lib/content-workflow.ts";

test("stage four persists version-bound reviews, comments, schedules, and publications", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  for (const table of ["content_reviews", "content_comments", "content_schedules", "publication_records"]) assert.match(schema, new RegExp(table));
  assert.match(schema, /idx_content_reviews_item_stage_round/);
  assert.match(schema, /idx_content_comments_project_visibility_created/);
  assert.match(schema, /idx_content_schedules_active_item/);
  assert.match(schema, /idx_publication_records_project_status_updated/);
});

test("every assigned employee can complete the internal workflow", async () => {
  const workflow = await import("../lib/content-workflow.ts");
  const base = { userId: "user-1", organizationId: "org-1", organizationRole: "member", projectId: "project-1" };
  const employee = { ...base, projectRole: "member" };
  assert.equal(workflow.allowedWorkflowTransition(employee, "draft", "internal_review"), true);
  assert.equal(workflow.allowedWorkflowTransition(employee, "internal_review", "publish_ready"), true);
  assert.equal(workflow.allowedWorkflowTransition(employee, "client_review", "publish_ready"), true);
  assert.equal(workflow.allowedWorkflowTransition(employee, "publish_ready", "published"), true);
  assert.equal(workflow.allowedWorkflowTransition(employee, "draft", "publish_ready"), false);
  assert.equal(workflow.allowedWorkflowTransition({ ...base, projectRole: null }, "internal_review", "publish_ready"), false);
  for (const status of ["shooting_ready", "shot", "editing"]) {
    assert.equal(workflow.workflowTransitionSchema.safeParse({ organizationId: base.organizationId, projectId: base.projectId, toStatus: status }).success, false);
    assert.equal(workflow.allowedWorkflowTransition(employee, "internal_review", status), false);
  }
  assert.equal(workflow.canCommentOnContent(employee, "internal"), true);
  assert.equal(workflow.canCommentOnContent(employee, "client"), true);
});

test("retired production states migrate without changing other content or timestamps", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE content_items (id INTEGER PRIMARY KEY, status TEXT, updated_at TEXT, deleted_at TEXT)");
  const statuses = [...workflow.contentStatuses, "shooting_ready", "shot", "editing"];
  for (const [id, status] of statuses.entries()) db.prepare("INSERT INTO content_items VALUES (?, ?, 'original-time', ?)").run(id, status, status === "shot" ? "deleted-time" : null);
  const migration = await readFile(new URL("../drizzle/0046_remove_production_statuses.sql", import.meta.url), "utf8");
  db.exec(migration);
  db.exec(migration);
  for (const row of db.prepare("SELECT * FROM content_items ORDER BY id").all()) {
    const original = statuses[row.id];
    assert.equal(row.status, ["shooting_ready", "shot", "editing"].includes(original) ? "publish_ready" : original);
    assert.equal(row.updated_at, "original-time");
    assert.equal(row.deleted_at, original === "shot" ? "deleted-time" : null);
  }
});

test("approval goes directly to publish-ready and records an approved version-bound review", async t => {
  const f = runtimeFixture(t), installation = await f.initialize();
  f.identity.userId = installation.userId;
  const organizationId = installation.organizationId, projectId = "review-project", now = "2026-09-12T00:00:00.000Z";
  const seed = (table, values) => {
    const columns = new Set(f.sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const row = Object.fromEntries(Object.entries({ id: crypto.randomUUID(), organization_id: organizationId, project_id: projectId, created_by: installation.userId, updated_by: installation.userId, created_at: now, updated_at: now, ...values }).filter(([key]) => columns.has(key)));
    f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    return row.id;
  };
  seed("projects", { id: projectId, name: "Review project", client_name: "Test" });
  const topicId = seed("topic_ideas", { title: "Test topic", source_type: "manual" });
  const contentId = seed("content_items", { topic_id: topicId, title: "Test content", status: "internal_review" });
  const versionId = seed("content_versions", { content_item_id: contentId, version: 1, generation_mode: "manual", pack_json: "{}", full_script: "Test script", short_script: "Test" });
  f.runtime.getProjectAccess = async () => ({ organizationRole: "member", projectRole: "member" });
  f.mock("lib/content-workflow.ts", workflow);
  const route = f.load("app/api/content-items/[contentId]/transition/route.ts");
  const approve = () => route.POST(new Request("http://localhost/api/content-items/test/transition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId, projectId, toStatus: "publish_ready" }) }), { params: Promise.resolve({ contentId }) });
  assert.equal((await approve()).status, 409);
  const reviewId = seed("content_reviews", { content_item_id: contentId, content_version_id: versionId, review_stage: "internal", round: 1, decision: "pending", requested_by: installation.userId, requested_at: now });
  assert.equal((await approve()).status, 200);
  assert.equal(f.sqlite.prepare("SELECT status FROM content_items WHERE id = ?").get(contentId).status, "publish_ready");
  const review = f.sqlite.prepare("SELECT * FROM content_reviews WHERE id = ?").get(reviewId);
  assert.equal(review.decision, "approved");
  assert.equal(review.content_version_id, versionId);
  assert.equal(review.decided_by, installation.userId);
  const audit = JSON.parse(f.sqlite.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'content.status.changed' AND target_id = ?").get(contentId).metadata_json);
  assert.equal(audit.fromStatus, "internal_review");
  assert.equal(audit.toStatus, "publish_ready");
});

test("workflow contracts require reasons and traceable publication outcomes", async () => {
  const workflow = await import("../lib/content-workflow.ts");
  const scope = { organizationId: "org-1", projectId: "project-1", expectedVersion:1 };
  assert.equal(workflow.workflowTransitionSchema.safeParse({ ...scope, toStatus: "internal_revision" }).success, false);
  assert.equal(workflow.workflowTransitionSchema.safeParse({ ...scope, toStatus: "internal_revision", note: "补充客户确认数据" }).success, true);
  assert.equal(workflow.publicationRecordSchema.safeParse({ ...scope, platform: "douyin", status: "published" }).success, false);
  assert.equal(workflow.publicationRecordSchema.safeParse({ ...scope, platform: "douyin", status: "published", externalUrl: "https://example.com/video/1" }).success, true);
});

test("returned review reasons become unclassified adoption candidates", async () => {
  const transition = await readFile(new URL("../app/api/content-items/[contentId]/transition/route.ts", import.meta.url), "utf8");
  assert.match(transition, /PROJECT_MEMORY_STORAGE_CATEGORY/);
  assert.match(transition, /PROJECT_MEMORY_STORAGE_KIND/);
  assert.match(transition, /'candidate'/);
  assert.doesNotMatch(transition, /reviewFeedbackMemoryCategory|projectMemoryKind/);
});

test("stage four APIs keep tenant scope, client visibility, audit events, and optimistic state", async () => {
  const [collection, transition, comments, schedule, publication] = await Promise.all([
    readFile(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/transition/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/comments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/schedule/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/publications/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(collection, /getProjectAccess/);
  assert.match(collection, /clientOnly/);
  assert.match(collection, /c\.visibility = 'client'/);
  assert.match(transition, /allowedWorkflowTransition/);
  assert.match(transition, /PENDING_REVIEW_REQUIRED/);
  assert.doesNotMatch(transition, /review_stage, round, decision, requested_by, requested_at\) VALUES \(\?, \?, \?, \?, \?, 'client'/);
  assert.match(transition, /content\.status\.changed/);
  assert.match(transition, /results\[0\]\.meta\.changes/);
  assert.match(transition, /INSERT INTO project_memory_items/);
  assert.match(transition, /INSERT INTO project_memory_evidence/);
  assert.match(transition, /'review_feedback'/);
  assert.ok(transition.indexOf("INSERT INTO project_memory_items") < transition.indexOf("db.batch(statements)"));
  assert.match(comments, /canCommentOnContent/);
  assert.match(schedule, /PUBLISH_READY_REQUIRED/);
  assert.match(publication, /external_url/);
  assert.match(publication, /content\.publication\.saved/);
});

test("review and publishing navigation use one real workflow workspace with calendar hidden", async () => {
  const [shell, page, workspace, collection] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workflow/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/WorkflowWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /\/workflow\?view=review/);
  assert.doesNotMatch(shell, /\/workflow\?view=calendar/);
  assert.match(shell, /\/workflow\?view=publish/);
  assert.match(page, /WorkflowWorkspace/);
  assert.match(workspace, /ReviewBoard/);
  assert.match(workspace, /CalendarView/);
  assert.match(workspace, /PublicationView/);
  assert.match(workspace, /ReviewContentPreview/);
  assert.match(workspace, /退回原因已保存为项目记忆候选/);
  assert.match(workspace, /查看记忆候选/);
  assert.match(workspace, /完整口播稿/);
  assert.match(workspace, /分镜脚本/);
  assert.match(collection, /v\.pack_json, v\.full_script, v\.short_script/);
  assert.doesNotMatch(collection, /clientReviewPack/);
});
