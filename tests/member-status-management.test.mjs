import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("member status controls explain self protection and confirm suspension or removal", async () => {
  const [manager, route, styles] = await Promise.all([
    readFile(new URL("../components/MemberManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(manager, /当前账号受保护，请由另一位管理员操作/);
  assert.match(manager, /暂停成员/);
  assert.match(manager, /移除成员/);
  assert.match(manager, /confirmMemberStatus/);
  assert.match(manager, /管理员可以随时恢复/);
  assert.match(route, /CANNOT_DISABLE_SELF/);
  assert.match(route, /LAST_ADMIN_REQUIRED/);
  assert.match(route, /UPDATE project_members SET status = 'removed'/);
  assert.match(route, /previousStatus: target\.status/);
  assert.match(route, /projectAccessRemoved/);
  assert.match(styles, /member-status-actions/);
  assert.match(styles, /self-protection-note/);
});
