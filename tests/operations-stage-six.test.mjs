import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("stage six persists organization capacity and enforces every expensive boundary", async () => {
  const [schema, operations, projects, members, url, upload, generate] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/from-url/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/content-items/[contentId]/generate/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /organization_settings/);
  assert.match(operations, /starter:[\s\S]*team:[\s\S]*scale:/);
  assert.match(projects, /PROJECT_QUOTA_EXCEEDED/);
  assert.match(members, /MEMBER_QUOTA_EXCEEDED/);
  assert.match(url, /ANALYSIS_QUOTA_EXCEEDED/);
  assert.match(upload, /STORAGE_QUOTA_EXCEEDED/);
  assert.match(generate, /MODEL_QUOTA_EXCEEDED/);
});

test("operations center monitors failures, heartbeats, overdue reviews, audit, and secret readiness", async () => {
  const route = await readFile(new URL("../app/api/operations/route.ts", import.meta.url), "utf8");
  assert.match(route, /getOrganizationAccess/);
  assert.match(route, /只有公司管理员可以查看系统运行、配额和完整审计/);
  assert.match(route, /STALE_ANALYSIS_JOBS/);
  assert.match(route, /FAILED_MODEL_CALLS/);
  assert.match(route, /OVERDUE_REVIEWS/);
  assert.match(route, /recentAudit/);
  assert.match(route, /runtime\.CONTENT_MODEL_API_KEY \|\| runtime\.ANALYZER_LLM_API_KEY/);
  assert.match(route, /analyzerOnline/);
  assert.match(route, /analyzer_workers/);
  assert.doesNotMatch(route, /CONTENT_MODEL_API_KEY[^\n]*return Response\.json/);
});

test("commercial organization controls preserve an active administrator and audit changes", async () => {
  const [members, projects] = await Promise.all([
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(members, /LAST_ADMIN_REQUIRED/);
  assert.match(members, /CANNOT_DISABLE_SELF/);
  assert.match(members, /invitation\.revoked/);
  assert.match(projects, /project\.status_updated/);
  assert.match(projects, /paused/);
  assert.match(projects, /archived/);
});

test("dashboard and search use real tenant-scoped records instead of sample copy", async () => {
  const [home, dashboard, search] = await Promise.all([
    readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/search/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(home, /所有数字均来自当前公司真实业务记录/);
  assert.doesNotMatch(home, /澄川管理咨询今天最需要推进/);
  assert.match(dashboard, /project_members own/);
  assert.match(search, /project_members own/);
  assert.match(search, /knowledge_items/);
});

test("local backup excludes secrets and restore keeps a rollback copy", async () => {
  const [backup, restore, ignore] = await Promise.all([
    readFile(new URL("../scripts/backup-local.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/restore-local.ps1", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(backup, /\.dev\.vars/);
  assert.match(restore, /RESTORE/);
  assert.match(restore, /state-before-restore/);
  assert.match(ignore, /\/backups\//);
});
