import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("topic deletion requires an administrator, exact-title confirmation, and keeps an audit trail", async () => {
  const [route, workspace, styles] = await Promise.all([
    readFile(new URL("../app/api/topics/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/TopicWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(route, /canDelete: access\.organizationRole === "admin"/);
  assert.match(route, /export async function DELETE/);
  assert.match(route, /access\.organizationRole !== "admin"/);
  assert.match(route, /confirmationTitle !== topic\.title/);
  assert.match(route, /SET deleted_at = \?, updated_by = \?, updated_at = \?/);
  assert.match(route, /["']topic\.deleted["']/);
  assert.match(route, /deletionMode: "soft"/);

  assert.match(workspace, /method: "DELETE"/);
  assert.match(workspace, /管理员确认/);
  assert.match(workspace, /输入完整选题标题以确认/);
  assert.match(workspace, /历史版本不会被删除/);
  assert.match(styles, /confirmation-backdrop/);
  assert.match(styles, /confirmation-danger/);
});
