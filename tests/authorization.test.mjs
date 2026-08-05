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
