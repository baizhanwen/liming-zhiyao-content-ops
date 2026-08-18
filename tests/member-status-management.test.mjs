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
  assert.match(route, /CANNOT_CHANGE_SELF/);
  assert.match(route, /LAST_ADMIN_REQUIRED/);
  assert.match(route, /UPDATE project_members SET status = 'removed'/);
  assert.match(route, /previousStatus: target\.status/);
  assert.match(route, /projectAccessRemoved/);
  assert.match(styles, /member-status-actions/);
  assert.match(styles, /self-protection-note/);
});

test("administrators can assign existing members to projects after invitation acceptance", async () => {
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
  assert.match(manager, /分配客户项目/);
  assert.match(manager, /updateProjectMembership/);
  assert.match(manager, /成员加入公司后，仍可随时增加项目、调整角色或移除项目权限/);
  assert.match(manager, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(manager, /已分配项目/);
  assert.match(manager, /实际项目成员/);
  assert.match(manager, /另有全局管理权/);
  assert.match(manager, /activeMembers\.map/);
  assert.doesNotMatch(manager, /member\.role === "admin" \? <span className="member-project-count">全部项目/);
  assert.match(manager, /requestMemberRoleChange/);
  assert.match(manager, /其所有项目角色会同步降为“项目只读”/);
  assert.match(manager, /member\.role === "readonly" \? "readonly"/);
  assert.match(manager, /inviteProjectId/);
  assert.match(projectsRoute, /pm\.organization_id = p\.organization_id/);
  assert.match(projectsRoute, /all_pm\.organization_id = p\.organization_id/);
  assert.match(projectsRoute, /organization_members all_om/);
  assert.match(route, /INCOMPATIBLE_ROLE_SCOPE/);
  assert.match(route, /LAST_PROJECT_OWNER_REQUIRED/);
  assert.match(route, /MEMBER_ALREADY_EXISTS/);
  assert.match(route, /INVITATION_ALREADY_PENDING/);
  assert.match(route, /UPDATE project_members SET role = 'readonly'/);
  assert.match(route, /CANNOT_CHANGE_SELF/);
  assert.match(invitationRoute, /INVITATION_ROLE_INVALID/);
  assert.match(invitationRoute, /INVITATION_PROJECT_UNAVAILABLE/);
  assert.match(invitationRoute, /MEMBER_ALREADY_EXISTS/);
  assert.match(runtime, /organization\.organizationRole === "admin"/);
  assert.match(authorization, /organizationRole !== "readonly"/);
  assert.match(workflow, /access\.organizationRole !== "readonly"/);
  assert.match(contentOps, /access\.organizationRole !== "readonly"/);
  assert.match(operations, /julianday\(expires_at\) > julianday\('now'\)/);
  assert.match(styles, /project-assignment-list/);
});
