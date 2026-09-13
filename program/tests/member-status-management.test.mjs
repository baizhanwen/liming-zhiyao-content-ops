import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("member status controls explain self protection and confirm suspension or removal", async () => {
  const [manager, route, styles] = await Promise.all([
    readFile(new URL("../components/MemberManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(manager, /唯一管理员身份不可转让或停用/);
  assert.match(manager, /暂停成员/);
  assert.match(manager, /移除成员/);
  assert.match(manager, /confirmMemberStatus/);
  assert.match(manager, /管理员可以随时恢复/);
  assert.match(route, /CANNOT_CHANGE_SELF/);
  assert.match(route, /ADMIN_ROLE_NOT_TRANSFERABLE/);
  assert.match(route, /UPDATE project_members SET status = 'removed'/);
  assert.match(route, /previousStatus: target\.status/);
  assert.match(route, /projectAccessRemoved/);
  assert.match(styles, /member-status-actions/);
  assert.match(styles, /self-protection-note/);
});

test("administrators assign employees to spaces without secondary roles", async () => {
  const [manager, route, invitationRoute, projectsRoute, runtime, authorization, workflow, contentOps, operations, styles] = await Promise.all([
    readFile(new URL("../components/MemberManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/invitations/accept/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/projects/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/content-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/content-ops.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/operations.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(route, /projectMemberships/);
  assert.match(route, /projectAction/);
  assert.match(route, /ON CONFLICT\(project_id, user_id\) DO UPDATE/);
  assert.match(route, /project\.member_assigned/);
  assert.match(route, /project\.member_removed/);
  assert.match(route, /MEMBER_NOT_ACTIVE/);
  assert.match(manager, /分配企业空间/);
  assert.match(manager, /updateProjectMembership/);
  assert.match(manager, /勾选员工即授予当前空间全部业务操作权限/);
  assert.match(manager, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(manager, /已分配空间/);
  assert.match(manager, /位已分配员工/);
  assert.match(manager, /另有全局管理权/);
  assert.match(manager, /activeEmployees\.map/);
  assert.doesNotMatch(manager, /member\.role === "admin" \? <span className="member-project-count">全部项目/);
  assert.doesNotMatch(manager, /requestMemberRoleChange/);
  assert.match(manager, /organizationRole: "member"/);
  assert.match(manager, /value="公司员工" readOnly/);
  assert.match(manager, /inviteProjectId/);
  assert.match(projectsRoute, /pm\.organization_id = p\.organization_id/);
  assert.match(projectsRoute, /all_pm\.organization_id = p\.organization_id/);
  assert.match(projectsRoute, /organization_members all_om/);
  assert.doesNotMatch(route, /INCOMPATIBLE_ROLE_SCOPE/);
  assert.doesNotMatch(route, /LAST_PROJECT_OWNER_REQUIRED/);
  assert.match(route, /MEMBER_ALREADY_EXISTS/);
  assert.match(route, /INVITATION_ALREADY_PENDING/);
  assert.match(route, /ADMIN_ROLE_NOT_TRANSFERABLE/);
  assert.match(route, /CANNOT_CHANGE_SELF/);
  assert.match(invitationRoute, /INVITATION_ROLE_INVALID/);
  assert.match(invitationRoute, /INVITATION_PROJECT_UNAVAILABLE/);
  assert.match(invitationRoute, /MEMBER_ALREADY_EXISTS/);
  assert.match(runtime, /organization\.organizationRole === "admin"/);
  assert.match(authorization, /projectRoles = \["member"\]/);
  assert.match(workflow, /access\.projectRole !== null/);
  assert.match(contentOps, /access\.projectRole !== null/);
  assert.match(operations, /julianday\(expires_at\) > julianday\('now'\)/);
  assert.match(styles, /project-assignment-list/);
});
