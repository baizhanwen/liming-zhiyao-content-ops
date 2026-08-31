import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
  assert.equal(workflow.allowedWorkflowTransition(employee, "internal_review", "shooting_ready"), true);
  assert.equal(workflow.allowedWorkflowTransition(employee, "client_review", "shooting_ready"), true);
  assert.equal(workflow.canCommentOnContent(employee, "internal"), true);
  assert.equal(workflow.canCommentOnContent(employee, "client"), true);
});

test("workflow contracts require reasons and traceable publication outcomes", async () => {
  const workflow = await import("../lib/content-workflow.ts");
  const scope = { organizationId: "org-1", projectId: "project-1" };
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

test("review, calendar, and publishing navigation use one real workflow workspace", async () => {
  const [shell, page, workspace, collection] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workflow/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/WorkflowWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workflow/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /\/workflow\?view=review/);
  assert.match(shell, /\/workflow\?view=calendar/);
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
