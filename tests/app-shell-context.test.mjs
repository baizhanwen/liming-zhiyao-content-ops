import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("app shell resolves the real member and current project on every route", async () => {
  const [shell, organizations, scope, projects, analysis, content, workflow] = await Promise.all([
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/organizations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client-scope.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ProjectManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/AnalysisWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/ContentProductionWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/WorkflowWorkspace.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(shell, /澄川管理咨询|>LX</);
  assert.match(shell, /fetch\("\/api\/organizations"\)/);
  assert.match(shell, /project\?\.name \|\| "尚未选择客户项目"/);
  assert.match(shell, /avatarText\(user\?\.displayName/);
  assert.match(organizations, /currentUser: \{ id: user\.id, email: user\.email, displayName:/);
  assert.match(scope, /window\.localStorage\.setItem/);
  for (const source of [projects, analysis, content, workflow]) assert.match(source, /rememberCurrentScope\(/);
});
