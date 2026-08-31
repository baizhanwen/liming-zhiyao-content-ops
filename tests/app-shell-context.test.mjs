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
  assert.match(shell, /project\?\.name \|\| "尚未选择企业空间"/);
  assert.match(shell, /avatarText\(user\?\.displayName/);
  assert.match(organizations, /currentUser: \{ id: user\.id, email: user\.email, displayName:/);
  assert.match(scope, /window\.localStorage\.setItem/);
  for (const source of [projects, analysis, content, workflow]) assert.match(source, /rememberCurrentScope\(/);
  assert.match(projects, /进入空间 →/);
  assert.match(projects, /window\.location\.assign/);
  assert.match(projects, /当前空间/);
});

test("enterprise spaces expose one space name without a separate brand field", async () => {
  const [manager, route, wechatImages, search] = await Promise.all([
    readFile(new URL("../components/ProjectManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/WechatImageWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/search/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(manager, /<label>空间名称<input name="name"/);
  assert.doesNotMatch(manager, /企业／品牌名称|name="clientName"|project\.client_name/);
  assert.doesNotMatch(route, /payload\.clientName|INVALID_CLIENT_NAME/);
  assert.match(route, /const clientName = name/);
  assert.match(route, /空间名称需要 2 至 80 个字符/);
  assert.doesNotMatch(wechatImages, /project\?\.client_name/);
  assert.match(wechatImages, /生成时会读取“\{project\?\.name\}”/);
  assert.doesNotMatch(search, /p\.client_name/);
  assert.match(search, /p\.name AS title, NULL AS subtitle/);
});
