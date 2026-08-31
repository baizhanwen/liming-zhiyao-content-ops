import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("company identity is a single non-transferable admin plus employees", async () => {
  const [roles, route, workspace, adminMigration, simplifiedMigration] = await Promise.all([
    readFile(new URL("../lib/authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/MemberManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0020_organization_admin_employee_roles.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0045_simplify_company_and_space_roles.sql", import.meta.url), "utf8"),
  ]);
  assert.match(roles, /organizationRoles = \["admin", "member"\]/);
  assert.match(route, /ADMIN_ROLE_NOT_TRANSFERABLE/);
  assert.match(route, /后续邀请只能添加公司员工/);
  assert.match(workspace, /公司员工/);
  assert.doesNotMatch(workspace, /value="readonly">只读成员/);
  assert.match(adminMigration, /idx_organization_one_active_admin/);
  assert.match(simplifiedMigration, /UPDATE project_members\s+SET role = 'member'/);
  assert.match(simplifiedMigration, /project_role = CASE WHEN project_id IS NULL THEN NULL ELSE 'member' END/);
});
