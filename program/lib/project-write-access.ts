export type ProjectWriteScope = { organizationId: string; projectId: string; userId: string };
type AccessDatabase = { prepare(sql: string): { bind(...values: unknown[]): { first(): Promise<unknown> } } };

export class ProjectWriteAccessChangedError extends Error {
  readonly code = "PROJECT_WRITE_ACCESS_CHANGED";
  constructor() { super("登录状态或项目权限已改变，已停止后续模型请求和内容保存；已经发出的请求仍计入用量。请刷新确认权限后再操作，先复制尚未保存的编辑内容。"); }
}

// Match getProjectAccess/canWriteProjectAccess against current database rows.
// Use inside the write/reservation statement to close the preflight race.
export const projectWriteAccessCondition = `EXISTS (SELECT 1 FROM projects p
  INNER JOIN organizations o ON o.id = p.organization_id
  INNER JOIN users u ON u.id = ?
  INNER JOIN organization_members om ON om.user_id = u.id AND om.organization_id = p.organization_id
  WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL AND p.status <> 'archived'
    AND o.status = 'active' AND u.status = 'active' AND om.status = 'active'
    AND (om.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm
      WHERE pm.organization_id = p.organization_id AND pm.project_id = p.id
        AND pm.user_id = u.id AND pm.status = 'active' AND pm.role IS NOT NULL)))`;
export const projectWriteAccessBindings = (scope: ProjectWriteScope) => [scope.userId, scope.projectId, scope.organizationId];

export async function assertProjectWriteAccess(db: AccessDatabase, scope: ProjectWriteScope) {
  if (!await db.prepare(`SELECT 1 WHERE ${projectWriteAccessCondition}`).bind(...projectWriteAccessBindings(scope)).first()) throw new ProjectWriteAccessChangedError();
}

export function createProjectWriteAssertion(db: AccessDatabase, scope: ProjectWriteScope, stillAuthenticated: () => Promise<boolean>) {
  return async () => {
    if (!await stillAuthenticated()) throw new ProjectWriteAccessChangedError();
    await assertProjectWriteAccess(db, scope);
  };
}
