import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("dashboard replaces the disposable starter", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.match(page, /上午好，林溪/);
  assert.match(page, /今日待办/);
  assert.match(page, /待审核内容/);
  assert.match(page, /下一步建议/);
  assert.match(layout, /lang="zh-CN"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("tenant schema carries organization and project scope", async () => {
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /organization_members/);
  assert.match(schema, /project_members/);
  assert.match(schema, /organization_id/);
  assert.match(schema, /project_id/);
  assert.match(schema, /idempotency_key/);
  assert.match(schema, /audit_logs/);
});

test("write APIs authenticate and re-check tenant scope on the server", async () => {
  const [organizations, projects, members, accept, runtime] = await Promise.all([
    readFile(new URL("../app/api/organizations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/invitations/accept/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  for (const route of [organizations, projects, members, accept]) assert.match(route, /readRequestIdentity/);
  assert.match(projects, /getOrganizationAccess/);
  assert.match(projects, /organizationRole !== "admin"/);
  assert.match(members, /只有公司管理员可以查看公司级成员与邀请/);
  assert.match(members, /hashInvitationToken/);
  assert.match(accept, /EMAIL_MISMATCH/);
  assert.match(runtime, /om\.organization_id = \?/);
  assert.match(runtime, /project_id = \?/);
});

test("analysis job state machine only allows explicit forward transitions and retries", async () => {
  const jobs = await import("../lib/analysis-jobs.ts");
  assert.equal(jobs.canTransitionAnalysisJob("pending", "queued"), true);
  assert.equal(jobs.canTransitionAnalysisJob("pending", "completed"), false);
  assert.equal(jobs.canTransitionAnalysisJob("completed", "pending"), false);
  assert.equal(jobs.canRetryAnalysisJob("failed"), true);
  assert.equal(jobs.canRetryAnalysisJob("cancelled"), true);
  assert.equal(jobs.canRetryAnalysisJob("analyzing"), false);
});

test("video ingestion checks project access before media buffering and uses private tenant prefixes", async () => {
  const [upload, fromUrl, retry, runtime] = await Promise.all([
    readFile(new URL("../app/api/videos/upload/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/videos/from-url/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analysis-jobs/[jobId]/retry/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(upload.indexOf("getProjectAccess") < upload.indexOf("request.formData"));
  assert.match(upload, /organizations\/\$\{organizationId\}\/projects\/\$\{projectId\}/);
  assert.match(upload, /sha256Hex\(bytes\)/);
  assert.match(upload, /best-effort rollback/);
  assert.match(fromUrl, /endsWith\("\.douyin\.com"\)/);
  assert.match(fromUrl, /VIDEO_ALREADY_EXISTS/);
  assert.match(retry, /status IN \('failed', 'cancelled'\)/);
  assert.match(runtime, /R2 binding MEDIA is unavailable/);
});
