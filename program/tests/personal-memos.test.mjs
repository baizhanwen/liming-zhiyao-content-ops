import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("personal memos are isolated to the signed-in employee and excluded from project memory", async () => {
  const [schema, migration, collectionRoute, itemRoute] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0035_personal_memos.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/personal-memos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/personal-memos/[memoId]/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /export const personalMemos/);
  assert.match(schema, /ownerUserId: text\("owner_user_id"\)/);
  assert.match(migration, /owner_user_id TEXT NOT NULL REFERENCES users\(id\)/);
  assert.match(collectionRoute, /memo\.owner_user_id = \?/);
  assert.match(itemRoute, /owner_user_id = \?/);
  assert.doesNotMatch(collectionRoute, /project_memory_items/);
});

test("report recommendations can be selected into the employee memo and managed on the dashboard", async () => {
  const [route, reports, dashboard] = await Promise.all([
    readFile(new URL("../app/api/personal-memos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/InsightsWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /sourceContent !== content/);
  assert.match(route, /INSERT OR IGNORE INTO personal_memos/);
  assert.match(reports, /记到我的备忘/);
  assert.match(reports, /sourceType: "performance_report"/);
  assert.match(dashboard, /仅自己可见/);
  assert.match(dashboard, /action: "complete" \| "reopen"/);
  assert.match(dashboard, /method: "DELETE"/);
});
